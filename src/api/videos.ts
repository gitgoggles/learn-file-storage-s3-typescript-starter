import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { s3 } from "bun";
import path from "path";

export function dbVideoToSignedVideo(cfg: ApiConfig, video: Video) {
	const key = video.videoURL;
	if (typeof key !== "string") {
		throw new BadRequestError("key missing from videoUrl");
	}
	const presignedURL = generatePresignedURL(cfg, key, 3600);
	if (typeof presignedURL === "string") {
		video.videoURL = presignedURL;
	}
	return video;
}
export function generatePresignedURL(
	cfg: ApiConfig,
	key: string,
	expireTime: number,
) {
	return s3.presign(key, {
		expiresIn: expireTime,
	});
}

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
	const MAX_UPLOAD_SIZE = 1 * 1024 * 1024 * 1024;
	const { videoId } = req.params as { videoId?: string };
	if (!videoId) {
		throw new BadRequestError("Invalid video ID");
	}

	const token = getBearerToken(req.headers);
	const userID = validateJWT(token, cfg.jwtSecret);
	const videoObject = getVideo(cfg.db, videoId);
	if (userID !== videoObject?.userID) {
		throw new UserForbiddenError("Not your video!");
	}
	const videoData = (await req.formData()).get("video");
	if (!(videoData instanceof File)) {
		throw new BadRequestError("File missing");
	}
	if (videoData.size > MAX_UPLOAD_SIZE) {
		throw new BadRequestError(`Video bigger than ${MAX_UPLOAD_SIZE} bytes`);
	}
	if (videoData.type !== "video/mp4") {
		throw new BadRequestError("File not video/mp4");
	}
	const key = `${videoId}.mp4`;
	const tempPath = path.join("/tmp", key);
	await Bun.write(tempPath, videoData);
	const aspectRatio = await getVideoAspectRatio(tempPath);

	const processedPath = await processVideoForFastStart(tempPath);

	const tempFile = Bun.file(processedPath);
	await s3.write(`${aspectRatio}/${key}`, tempFile, {
		type: videoData.type,
	});
	const videoUrl = `https://${cfg.cloudfrontDomain}/${aspectRatio}/${key}`;
	// const videoUrl = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${aspectRatio}/${key}`;
	// const videoUrl = `${aspectRatio}/${key}`;

	videoObject.videoURL = videoUrl;
	updateVideo(cfg.db, videoObject);

	await Bun.file(tempPath).delete();
	// const presignedVideo = await dbVideoToSignedVideo(cfg, metaData);

	return respondWithJSON(200, videoObject);
}

export async function getVideoAspectRatio(filePath: string) {
	const proc = Bun.spawn([
		"ffprobe",
		"-v",
		"error",
		"-select_streams",
		"v:0",
		"-show_entries",
		"stream=width,height",
		"-of",
		"json",
		filePath,
	]);
	await proc.exited;
	const exitCode = proc.exitCode;

	if (exitCode !== 0) {
		throw new BadRequestError(`ffprobe failed: ${filePath}`);
	}

	const stdoutText = await new Response(proc.stdout).text();
	const stderrText = await new Response(proc.stderr).text();

	const parsed = JSON.parse(stdoutText);
	const width = parsed.streams[0]?.width;
	const height = parsed.streams[0]?.height;

	if (width > height) {
		return "landscape";
	}
	if (width < height) {
		return "portrait";
	} else {
		return "other";
	}
}

export async function processVideoForFastStart(inputFilePath: string) {
	const outputFilePath = `${inputFilePath}.processed`;

	const proc = Bun.spawn([
		"ffmpeg",
		"-i",
		inputFilePath,
		"-movflags",
		"faststart",
		"-map_metadata",
		"0",
		"-codec",
		"copy",
		"-f",
		"mp4",
		outputFilePath,
	]);

	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		throw new BadRequestError(`Failed to process video: ${inputFilePath}`);
	}

	return outputFilePath;
}
