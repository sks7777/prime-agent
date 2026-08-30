import { applyExifOrientation } from "./exif-orientation.js";
import { loadPhoton } from "./photon.js";

/**
 * Convert image to PNG format for terminal display.
 * Kitty graphics protocol requires PNG format (f=100).
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	// Already PNG, no conversion needed
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	const photon = await loadPhoton();
	if (!photon) {
		// Photon not available, can't convert
		return null;
	}

	try {
		const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
		const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
		const image = applyExifOrientation(photon, rawImage, bytes);
		if (image !== rawImage) rawImage.free();
		try {
			const pngBuffer = image.get_bytes();
			return {
				data: Buffer.from(pngBuffer).toString("base64"),
				mimeType: "image/png",
			};
		} finally {
			image.free();
		}
	} catch {
		// Conversion failed
		return null;
	}
}

export async function convertImageBytesToPng(bytes: Uint8Array, mimeType?: string): Promise<Uint8Array | null> {
	try {
		const detected =
			mimeType ??
			(bytes[0] === 0x89 && bytes[1] === 0x50
				? "image/png"
				: bytes[0] === 0xff && bytes[1] === 0xd8
					? "image/jpeg"
					: bytes[8] === 0x57 && bytes[9] === 0x45
						? "image/webp"
						: "image/png");
		const base64 = Buffer.from(bytes).toString("base64");
		const converted = await convertToPng(base64, detected);
		if (!converted) return null;
		return new Uint8Array(Buffer.from(converted.data, "base64"));
	} catch {
		return null;
	}
}
