import { Marked } from "marked";
import type { ReactNode } from "react";
import { memo, useMemo } from "react";

function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function safeHref(href: string): string | null {
	const trimmed = href.trim();
	if (/^(?:https?:|mailto:)/i.test(trimmed)) return trimmed;
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null; // unknown scheme (javascript:, data:, …)
	return trimmed; // relative / fragment
}

const md = new Marked({
	gfm: true,
	renderer: {
		// Raw HTML tokens (block + inline both arrive here) are escaped, never emitted.
		html({ text }) {
			return escapeHtml(text);
		},
		link({ href, title, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const url = safeHref(href);
			if (url === null) return inner;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener">${inner}</a>`;
		},
	},
});

export const Markdown = memo(function Markdown({ text }: { text: string }): ReactNode {
	const html = useMemo(() => {
		try {
			return md.parse(text, { async: false });
		} catch {
			return escapeHtml(text);
		}
	}, [text]);
	return <div className="tr-md" dangerouslySetInnerHTML={{ __html: html }} />;
});
