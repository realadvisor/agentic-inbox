import { z } from "zod";

export const translationLanguages = {
	en: "English",
	fr: "Français",
	de: "Deutsch",
	it: "Italiano",
	es: "Español",
	pt: "Português",
	nl: "Nederlands",
	pl: "Polski",
	uk: "Українська",
	ru: "Русский",
	ar: "العربية",
	he: "עברית",
	tr: "Türkçe",
	el: "Ελληνικά",
	ro: "Română",
	cs: "Čeština",
	hu: "Magyar",
	sv: "Svenska",
	da: "Dansk",
	no: "Norsk",
	fi: "Suomi",
	ja: "日本語",
	ko: "한국어",
	zh: "中文",
	hi: "हिन्दी",
	id: "Bahasa Indonesia",
	vi: "Tiếng Việt",
	th: "ไทย",
} as const;
export type TranslationLanguage = keyof typeof translationLanguages;
export function isTranslationLanguage(
	value: string,
): value is TranslationLanguage {
	return Object.hasOwn(translationLanguages, value);
}
export function browserTranslationLanguage(
	languages: readonly string[],
): TranslationLanguage {
	for (const locale of languages) {
		const language = locale.toLowerCase().split(/[-_]/)[0];
		if (isTranslationLanguage(language)) return language;
	}
	return "en";
}
export const translationSchema = z
	.object({
		targetLanguage: z
			.string()
			.refine(isTranslationLanguage, "Choose a supported translation language"),
	})
	.strict();
export interface TranslationResult {
	html: string;
	text: string;
	targetLanguage: TranslationLanguage;
}
