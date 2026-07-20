// Minimal ambient types for `mammoth` (ships no types). Declares only what
// DocxConverter uses. See ../NOTICE.
declare module "mammoth" {
	interface MammothImage {
		contentType?: string;
		read(encoding: "base64"): Promise<string>;
	}
	interface ImgAttributes {
		src: string;
		alt?: string;
	}
	type ConvertImageHandler = (image: MammothImage) => Promise<ImgAttributes>;
	interface ConvertOptions {
		convertImage?: ConvertImageHandler;
	}
	interface ConvertResult {
		value: string;
		messages: unknown[];
	}
	export const images: { imgElement(fn: ConvertImageHandler): ConvertImageHandler };
	export function convertToHtml(input: { buffer: Buffer }, options?: ConvertOptions): Promise<ConvertResult>;
	const _default: { convertToHtml: typeof convertToHtml; images: typeof images };
	export default _default;
}
