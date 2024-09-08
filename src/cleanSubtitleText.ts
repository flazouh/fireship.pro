import { JSDOM } from "jsdom";

export function cleanSubtitleText(text: string): string {
	const dom = new JSDOM("<!DOCTYPE html>");
	return text
		.replace(/&(#?[a-zA-Z0-9]+);/g, (match, entity) => {
			const decoded = new dom.window.DOMParser().parseFromString(`&${entity};`, "text/html").body
				.textContent;
			return decoded || match;
		})
		.replace(/\\(\d{3})([a-zA-Z])/g, (_, octal, char) => {
			const decodedChar = String.fromCharCode(Number.parseInt(octal, 8));
			return decodedChar + char;
		})
		.trim();
}
