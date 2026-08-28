// Node 22 supports Unicode Sets while the package's conservative TypeScript
// target rejects `v` regex literals, so construct these fixed patterns at runtime.
const UNICODE_SETS_FLAG = "v";

export const zeroWidthRegex = new RegExp(
	"^[\\p{Default_Ignorable_Code_Point}\\p{Control}\\p{Mark}\\p{Surrogate}]+$",
	UNICODE_SETS_FLAG,
);
export const leadingNonPrintingRegex = new RegExp(
	"^[\\p{Default_Ignorable_Code_Point}\\p{Control}\\p{Format}\\p{Mark}\\p{Surrogate}]+",
	UNICODE_SETS_FLAG,
);
export const rgiEmojiRegex = new RegExp("^\\p{RGI_Emoji}$", UNICODE_SETS_FLAG);
