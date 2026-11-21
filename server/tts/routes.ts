import express, { type ErrorRequestHandler, type Response } from "express";
import { createTtsService, type TtsService } from "./service.js";
import { TtsError } from "./types.js";

function failure(res: Response, error: unknown): void {
	if (res.destroyed || res.writableEnded) return;
	const status = error instanceof TtsError ? error.status : 502;
	if (status === 429) res.setHeader("Retry-After", "1");
	res.status(status).json({ error: error instanceof TtsError ? error.message : "TTS 服务暂时不可用" });
}

/** Registered after the shared express.json() as route-scoped error middleware. */
export const ttsJsonErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
	const status = error?.type === "entity.too.large" ? 413 : 400;
	res.status(status).json({ error: status === 413 ? "TTS 请求体过大" : "TTS 请求体必须是有效 JSON" });
};

export function createTtsRouter(service: TtsService = createTtsService()): express.Router {
	const router = express.Router();
	router.use((_req, res, next) => {
		res.setHeader("Cache-Control", "no-store");
		next();
	});
	router.get("/voices", (req, res) => {
		try {
			res.json(service.voices(req.query.provider));
		} catch (error) {
			failure(res, error);
		}
	});
	router.post("/speak", async (req, res) => {
		const controller = new AbortController();
		const abort = () => controller.abort(new TtsError(499, "TTS 请求已取消"));
		const close = () => {
			if (!res.writableEnded) abort();
		};
		req.once("aborted", abort);
		res.once("close", close);
		try {
			if (req.aborted || res.destroyed) abort();
			const { audio, contentType } = await service.speak(req.body, controller.signal);
			if (!controller.signal.aborted) res.type(contentType).send(audio);
		} catch (error) {
			failure(res, error);
		} finally {
			req.off("aborted", abort);
			res.off("close", close);
		}
	});
	return router;
}
