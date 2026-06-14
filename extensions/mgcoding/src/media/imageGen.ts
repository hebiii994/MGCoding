/*---------------------------------------------------------------------------------------------
 *  MGCoding - generazione immagini (Text-to-Image) con auto-configurazione.
 *  Rileva il backend migliore disponibile: prima un server di diffusion LOCALE in ascolto
 *  (Automatic1111/SD.Next/Forge su :7860, ComfyUI su :8188), poi il CLOUD riusando le API key
 *  gia configurate dall'utente (Gemini -> Imagen, OpenAI -> gpt-image-1). Nessuna dipendenza
 *  esterna: solo fetch.
 *--------------------------------------------------------------------------------------------*/

export type ImageBackendId = 'a1111' | 'comfyui' | 'gemini' | 'openai';

export interface ImageBackend {
	id: ImageBackendId;
	label: string;
	endpoint?: string;
	model?: string;
	local: boolean;
}

export interface ImageGenOptions {
	/** Rapporto d'aspetto richiesto: "1:1" | "16:9" | "9:16" | "4:3" | "3:4". */
	aspect?: string;
	count?: number;
	/** Negative prompt (cosa evitare) per i backend che lo supportano (A1111, ComfyUI). */
	negative?: string;
}

const DEFAULT_NEGATIVE = 'low quality, blurry, deformed, bad anatomy, watermark, text';

export interface ImageGenResult {
	/** Immagini in base64 grezzo (senza prefisso data:). */
	images: string[];
	mediaType: string;
	backendLabel: string;
}

/** Chiavi cloud da riusare (gia inserite dall'utente per la chat). */
export interface CloudKeys {
	geminiKey?: string;
	openaiKey?: string;
}

const A1111_DEFAULT = 'http://127.0.0.1:7860';
const COMFY_DEFAULT = 'http://127.0.0.1:8188';

/** GET con timeout breve per il probe dei server locali. */
async function probe(url: string, ms = 1200): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Rileva il backend immagine da usare. Ordine: scelta esplicita -> locale (A1111, ComfyUI)
 * -> cloud (Gemini, OpenAI). Ritorna undefined se non c'e nulla di disponibile.
 */
export async function detectImageBackend(
	preferred: string,
	a1111Endpoint: string,
	comfyEndpoint: string,
	keys: CloudKeys
): Promise<ImageBackend | undefined> {
	const a1111 = (a1111Endpoint || A1111_DEFAULT).replace(/\/$/, '');
	const comfy = (comfyEndpoint || COMFY_DEFAULT).replace(/\/$/, '');

	const tryA1111 = async (): Promise<ImageBackend | undefined> =>
		(await probe(`${a1111}/sdapi/v1/sd-models`)) ? { id: 'a1111', label: 'Stable Diffusion locale (A1111/SD.Next)', endpoint: a1111, local: true } : undefined;
	const tryComfy = async (): Promise<ImageBackend | undefined> =>
		(await probe(`${comfy}/system_stats`)) ? { id: 'comfyui', label: 'ComfyUI locale', endpoint: comfy, local: true } : undefined;
	const tryGemini = (): ImageBackend | undefined =>
		keys.geminiKey ? { id: 'gemini', label: 'Google Imagen (cloud)', model: 'imagen-3.0-generate-002', local: false } : undefined;
	const tryOpenai = (): ImageBackend | undefined =>
		keys.openaiKey ? { id: 'openai', label: 'OpenAI gpt-image-1 (cloud)', model: 'gpt-image-1', local: false } : undefined;

	switch (preferred) {
		case 'a1111': return (await tryA1111()) ?? undefined;
		case 'comfyui': return (await tryComfy()) ?? undefined;
		case 'gemini': return tryGemini();
		case 'openai': return tryOpenai();
		default: break; // 'auto'
	}
	return (await tryA1111()) ?? (await tryComfy()) ?? tryGemini() ?? tryOpenai();
}

/** Converte un aspect ("16:9") in dimensioni px per i backend che vogliono width/height. */
function aspectToSize(aspect?: string): { width: number; height: number } {
	switch (aspect) {
		case '16:9': return { width: 1344, height: 768 };
		case '9:16': return { width: 768, height: 1344 };
		case '4:3': return { width: 1152, height: 896 };
		case '3:4': return { width: 896, height: 1152 };
		default: return { width: 1024, height: 1024 };
	}
}

/** OpenAI vuole una size tra quelle ammesse: mappa l'aspect a quella piu vicina. */
function aspectToOpenAISize(aspect?: string): string {
	if (aspect === '16:9' || aspect === '4:3') {
		return '1536x1024';
	}
	if (aspect === '9:16' || aspect === '3:4') {
		return '1024x1536';
	}
	return '1024x1024';
}

/** Genera una o piu immagini col backend scelto. */
export async function generateImage(
	backend: ImageBackend,
	prompt: string,
	opts: ImageGenOptions,
	keys: CloudKeys,
	signal?: AbortSignal
): Promise<ImageGenResult> {
	switch (backend.id) {
		case 'a1111': return genA1111(backend.endpoint!, prompt, opts, signal);
		case 'comfyui': return genComfy(backend.endpoint!, prompt, opts, signal);
		case 'gemini': return genGemini(keys.geminiKey!, backend.model!, prompt, opts, signal);
		case 'openai': return genOpenAI(keys.openaiKey!, backend.model!, prompt, opts, signal);
	}
}

async function genA1111(endpoint: string, prompt: string, opts: ImageGenOptions, signal?: AbortSignal): Promise<ImageGenResult> {
	const { width, height } = aspectToSize(opts.aspect);
	const res = await fetch(`${endpoint}/sdapi/v1/txt2img`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ prompt, negative_prompt: opts.negative ?? DEFAULT_NEGATIVE, steps: 28, width, height, batch_size: Math.min(opts.count ?? 1, 4), cfg_scale: 6 }),
		signal
	});
	if (!res.ok) {
		throw new Error(`Server locale ha risposto ${res.status}`);
	}
	const data = await res.json() as { images?: string[] };
	if (!data.images?.length) {
		throw new Error('Il server locale non ha restituito immagini.');
	}
	return { images: data.images, mediaType: 'image/png', backendLabel: 'Stable Diffusion locale' };
}

async function genComfy(endpoint: string, prompt: string, opts: ImageGenOptions, signal?: AbortSignal): Promise<ImageGenResult> {
	// Trova un checkpoint disponibile.
	const infoRes = await fetch(`${endpoint}/object_info/CheckpointLoaderSimple`, { signal });
	if (!infoRes.ok) {
		throw new Error('ComfyUI: impossibile leggere i checkpoint.');
	}
	const info = await infoRes.json() as Record<string, { input?: { required?: { ckpt_name?: unknown[][] } } }>;
	const ckpts = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] as string[] | undefined;
	const ckpt = ckpts?.[0];
	if (!ckpt) {
		throw new Error('ComfyUI è attivo ma non ha nessun checkpoint installato. Scaricane uno con il comando "MGCoding: Scarica modello immagini" (es. SDXL Base), poi riprova.');
	}
	const { width, height } = aspectToSize(opts.aspect);
	const seed = Math.floor(Math.random() * 1e15);
	// Workflow txt2img minimale standard.
	const workflow = {
		'3': { class_type: 'KSampler', inputs: { seed, steps: 28, cfg: 6, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
		'4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
		'5': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
		'6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
		'7': { class_type: 'CLIPTextEncode', inputs: { text: opts.negative ?? DEFAULT_NEGATIVE, clip: ['4', 1] } },
		'8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
		'9': { class_type: 'SaveImage', inputs: { filename_prefix: 'MGCoding', images: ['8', 0] } }
	};
	const images = await queueAndCollect(endpoint, workflow, signal);
	return { images, mediaType: 'image/png', backendLabel: 'ComfyUI locale' };
}

/** Accoda un workflow ComfyUI, attende il completamento e raccoglie le immagini (base64). */
export async function queueAndCollect(endpoint: string, workflow: object, signal?: AbortSignal): Promise<string[]> {
	const ep = endpoint.replace(/\/$/, '');
	const clientId = `mgcoding-${Date.now()}`;
	const queue = await fetch(`${ep}/prompt`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ prompt: workflow, client_id: clientId }), signal
	});
	if (!queue.ok) {
		const t = await queue.text().catch(() => '');
		throw new Error(`ComfyUI ha rifiutato il job (${queue.status}): ${t.slice(0, 200)}`);
	}
	const { prompt_id } = await queue.json() as { prompt_id: string };
	// Polling della history finche il job non e completo (max ~180s).
	for (let i = 0; i < 180; i++) {
		if (signal?.aborted) {
			throw new Error('Annullato.');
		}
		await new Promise(r => setTimeout(r, 1000));
		const h = await fetch(`${ep}/history/${prompt_id}`, { signal }).catch(() => undefined);
		if (!h?.ok) {
			continue;
		}
		const hist = await h.json() as Record<string, { outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> }>;
		const entry = hist[prompt_id];
		if (!entry?.outputs) {
			continue;
		}
		const imgs: string[] = [];
		for (const out of Object.values(entry.outputs)) {
			for (const im of out.images ?? []) {
				const v = await fetch(`${ep}/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder)}&type=${im.type}`, { signal });
				if (v.ok) {
					imgs.push(Buffer.from(await v.arrayBuffer()).toString('base64'));
				}
			}
		}
		if (imgs.length) {
			return imgs;
		}
	}
	throw new Error('ComfyUI: timeout in attesa del risultato.');
}

async function genGemini(key: string, model: string, prompt: string, opts: ImageGenOptions, signal?: AbortSignal): Promise<ImageGenResult> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${encodeURIComponent(key)}`;
	const res = await fetch(url, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: Math.min(opts.count ?? 1, 4), aspectRatio: opts.aspect ?? '1:1' } }),
		signal
	});
	if (!res.ok) {
		const t = await res.text().catch(() => '');
		throw new Error(`Imagen ha risposto ${res.status}: ${t.slice(0, 200)}`);
	}
	const data = await res.json() as { predictions?: { bytesBase64Encoded?: string }[] };
	const images = (data.predictions ?? []).map(p => p.bytesBase64Encoded).filter((x): x is string => !!x);
	if (!images.length) {
		throw new Error('Imagen non ha restituito immagini (prompt bloccato dai filtri?).');
	}
	return { images, mediaType: 'image/png', backendLabel: 'Google Imagen' };
}

async function genOpenAI(key: string, model: string, prompt: string, opts: ImageGenOptions, signal?: AbortSignal): Promise<ImageGenResult> {
	const res = await fetch('https://api.openai.com/v1/images/generations', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key}` },
		body: JSON.stringify({ model, prompt, size: aspectToOpenAISize(opts.aspect), n: Math.min(opts.count ?? 1, 4) }),
		signal
	});
	if (!res.ok) {
		const t = await res.text().catch(() => '');
		throw new Error(`OpenAI ha risposto ${res.status}: ${t.slice(0, 200)}`);
	}
	const data = await res.json() as { data?: { b64_json?: string; url?: string }[] };
	const images: string[] = [];
	for (const d of data.data ?? []) {
		if (d.b64_json) {
			images.push(d.b64_json);
		} else if (d.url) {
			const r = await fetch(d.url, { signal });
			images.push(Buffer.from(await r.arrayBuffer()).toString('base64'));
		}
	}
	if (!images.length) {
		throw new Error('OpenAI non ha restituito immagini.');
	}
	return { images, mediaType: 'image/png', backendLabel: 'OpenAI gpt-image-1' };
}
