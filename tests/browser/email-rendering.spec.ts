import { test, expect, type Page } from "@playwright/test";

async function render(page: Page, html: string) {
	await page.route("**/renderer-test", (route) => route.fulfill({
		contentType: "text/html",
		body: `<style>iframe{display:block;width:100%;border:0}</style><div id="root" style="width:700px"></div>
<script type="module" src="/tests/browser/email-rendering.fixture.tsx"></script>`,
	}));
	await page.goto("/renderer-test");
	await page.waitForFunction(() => "renderEmail" in window);
	await page.evaluate(body => (window as unknown as {renderEmail:(s:string)=>void}).renderEmail(body), html);
	await expect(page.locator("iframe")).toBeVisible();
	return page.frameLocator("iframe");
}

test("preserves full-document styles, body colors, table spacing and responsive layout", async ({ page }) => {
	const frame = await render(page, `<html><head><style>
body { background:#f0e0d0; } .card { width:600px; border-spacing:12px; } td { padding:19px; } p { margin:23px 0; }
@media(max-width:500px) { .card { width:100%; } td { padding:7px; } }
</style></head><body style="color:#123456"><table class="card"><tr><td><p>Newsletter</p></td></tr></table></body></html>`);
	await expect(frame.locator("body")).toHaveCSS("background-color", "rgb(240, 224, 208)");
	await expect(frame.locator("body")).toHaveCSS("color", "rgb(18, 52, 86)");
	await expect(frame.locator("td")).toHaveCSS("padding-top", "19px");
	await expect(frame.locator("p")).toHaveCSS("margin-top", "23px");
	await page.screenshot({ path: test.info().outputPath("email-desktop.png") });
	await page.locator("#root").evaluate(el => { el.style.width = "360px"; });
	await page.locator("iframe").evaluate(el => { el.style.width = "100%"; });
	await expect(frame.locator("td")).toHaveCSS("padding-top", "7px");
});

test("resizes after delayed images and shrinks on responsive reflow and message replacement", async ({ page }) => {
	const frame = await render(page, '<img id="late"><p>End of email</p>');
	await frame.locator("#late").evaluate(image => {
		setTimeout(() => {
			(image as HTMLImageElement).src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="650"><rect width="200" height="650" fill="blue"/></svg>');
		}, 800);
	});
	await expect.poll(async () => (await page.locator("iframe").boundingBox())!.height).toBeGreaterThan(650);
	await expect(frame.getByText("End of email")).toBeVisible();
	await page.evaluate(() => (window as unknown as {renderEmail:(s:string)=>void}).renderEmail('<style>.block{height:800px}@media(min-width:600px){.block{height:160px}}</style><div class="block">Responsive</div>'));
	await page.locator("iframe").evaluate(el => { el.style.width = "350px"; });
	await expect.poll(async () => (await page.locator("iframe").boundingBox())!.height).toBeGreaterThanOrEqual(800);
	await page.locator("iframe").evaluate(el => { el.style.width = "700px"; });
	await expect.poll(async () => (await page.locator("iframe").boundingBox())!.height).toBeLessThan(300);
	await page.evaluate(() => (window as unknown as {renderEmail:(s:string)=>void}).renderEmail(""));
	await expect(frame.getByText("Responsive", {exact:true})).toHaveCount(0);
});

test("blocks email scripts, forms, stylesheet requests and parent access while keeping links", async ({ page }) => {
	const requests: string[] = [];
	page.context().on("request", req => { if (req.url().includes("attacker.test")) requests.push(req.url()); });
	const frame = await render(page, `<head><meta http-equiv="refresh" content="0;url=https://attacker.test"><link rel="stylesheet" href="https://attacker.test/style"></head>
<style>@import 'https://attacker.test/import'; .bad { background:url(https://attacker.test/css); cursor:image-set('https://attacker.test/img' 1x); } .good{color:rgb(1,2,3)}</style>
<script>parent.document.body.innerHTML='hacked'</script><img src="data:image/png,invalid" onerror="parent.postMessage('hacked','*')">
<form action="https://attacker.test"><input autofocus></form><a href="javascript:alert(1)">Bad</a><a href="https://example.com">Good</a><p class="good bad">Safe text</p>`);
	await expect(frame.locator("p")).toHaveCSS("color", "rgb(1, 2, 3)");
	await expect(frame.locator("form, input, link, [onerror]")).toHaveCount(0);
	await expect(frame.getByText("Bad", {exact:true})).not.toHaveAttribute("href");
	await expect(frame.getByText("Good", {exact:true})).toHaveAttribute("rel", "noopener noreferrer");
	await expect(frame.locator("script")).toHaveCount(1);
	const child = page.frames().find(f => f !== page.mainFrame())!;
	expect(await child.evaluate(() => { try { return !!parent.document; } catch { return false; } })).toBe(false);
	await child.evaluate(() => { const s = document.createElement('script'); s.textContent = 'document.body.dataset.compromised="yes"'; document.body.append(s); });
	await expect(frame.locator("body")).not.toHaveAttribute("data-compromised");
	expect(requests).toEqual([]);
});

test("keeps wide email content reachable and rejects spoofed height reports", async ({ page }) => {
	const frame = await render(page, '<table width="1100"><tr><td>Wide invoice</td><td>Last column</td></tr></table>');
	await expect(frame.getByText("Last column")).toBeAttached();
	expect(await frame.locator("body").evaluate(el => el.scrollWidth)).toBeGreaterThan(1000);
	await page.evaluate(() => window.postMessage({__emailIframeHeight:true,height:99999}, '*'));
	await expect.poll(async () => (await page.locator("iframe").boundingBox())!.height).toBeLessThan(500);
});
