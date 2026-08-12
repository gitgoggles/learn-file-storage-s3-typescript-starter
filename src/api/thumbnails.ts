import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";
import { randomBytes } from "crypto";

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
	const { videoId } = req.params as { videoId?: string };
	if (!videoId) {
		throw new BadRequestError("Invalid video ID");
	}

	const token = getBearerToken(req.headers);
	const userID = validateJWT(token, cfg.jwtSecret);

	console.log("uploading thumbnail for video", videoId, "by user", userID);

	const formData = await req.formData();
	const thumbnail = formData.get("thumbnail");
	if (!(thumbnail instanceof File)) {
		throw new BadRequestError("thumbnail missing");
	}
	const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;
	if (thumbnail.size > MAX_UPLOAD_SIZE) {
		throw new BadRequestError("thumbnail file too big");
	}

	const mediaType = thumbnail.type;
	const fileExtension = mediaType.split("/")[1];
	if (fileExtension !== "jpg" && fileExtension !== "png") {
		throw new BadRequestError("Only jpg or png accepted");
	}
	const arrayBuffer = await thumbnail.arrayBuffer();
	const buffer = Buffer.from(arrayBuffer);
	const rand32Byte = randomBytes(32).toString("base64url");
	const fileUrl = `http://localhost:${cfg.port}/assets/${rand32Byte}.${fileExtension}`;
	const filePath = path.join(
		cfg.assetsRoot,
		`${rand32Byte}.${fileExtension}`,
	);

	const metaData = getVideo(cfg.db, videoId);
	if (userID !== metaData?.userID) {
		throw new UserForbiddenError("Not your video!");
	}
	Bun.write(filePath, buffer);

	metaData.thumbnailURL = fileUrl;
	updateVideo(cfg.db, metaData);

	return respondWithJSON(200, metaData);
}
