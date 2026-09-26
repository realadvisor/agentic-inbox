import { createRoot } from "react-dom/client";
import EmailIframe from "../../app/components/EmailIframe";

const root = createRoot(document.getElementById("root")!);
(window as unknown as { renderEmail: (body: string) => void }).renderEmail = (body) => {
	root.render(<EmailIframe body={body} autoSize />);
};
