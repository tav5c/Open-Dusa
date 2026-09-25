// Vision layer: image extraction from messages/replies, text-attachment
// ingestion, and the two-stage vision call (describe -> persona rewrite).
import { ResearchCore } from './research.js'
import { FairQueue, estTokens } from './fairqueue.js'
import { loadPerformance } from '../performance.js'

const PERF = loadPerformance()

export class VisionCore extends ResearchCore {
    // Vision pipeline
    async _processTextAttachments(message) {
        const TEXT_EXTS = new Set([
            '.txt',
            '.md',
            '.js',
            '.mjs',
            '.cjs',
            '.ts',
            '.jsx',
            '.tsx',
            '.py',
            '.json',
            '.css',
            '.html',
            '.c',
            '.cpp',
            '.h',
            '.java',
            '.go',
            '.rs',
            '.rb',
            '.sh',
            '.yaml',
            '.yml',
            '.toml',
            '.xml',
            '.sql',
            '.log',
            '.env',
            '.ini',
            '.cfg',
            '.vue',
            '.svelte',
            '.cs',
            '.php',
            '.lua',
            '.dart',
            '.kt',
            '.swift',
            '.ex',
            '.exs',
        ])
        const allText = [...message.attachments.values()].filter((att) => {
            const ct = (att.contentType ?? '').toLowerCase()
            const ext = att.name?.split('.').pop()?.toLowerCase()
            return ct.includes('text/') || TEXT_EXTS.has('.' + ext)
        })
        // Spoiler-tagged files stay unopened unless explicitly asked for —
        // the tag means "hide by default", describing them would defeat it.
        const spoilerFiles = allText.filter((att) => att.spoiler)
        const textAtts = allText.filter((att) => !att.spoiler)
        const spoilerNote = spoilerFiles.length
            ? `\n\n[${spoilerFiles.length} spoiler-tagged file(s) left unopened — ask me to read them and I will.]`
            : ''
        if (!textAtts.length) return spoilerNote
        const totalSize = textAtts.reduce((sum, att) => sum + att.size, 0)
        if (totalSize > 150_000)
            return `\n\n[${textAtts.length} file(s) skipped, combined size ${(totalSize / 1024).toFixed(0)}KB exceeds limit]`
        // Fetch all text attachments in parallel
        const results = await Promise.all(
            textAtts.map(async (att) => {
                if (att.size > 80_000)
                    return `\n\n[File: \`${att.name}\`, too large to read (${(att.size / 1024).toFixed(0)}KB)]`
                try {
                    const res = await fetch(att.url, { signal: AbortSignal.timeout(10_000) })
                    const text = await res.text()
                    return `\n\n[Attached File: ${att.name}]\n\`\`\`\n${text.slice(0, 10000)}\n\`\`\``
                } catch (e) {
                    console.error('[AI] Text fetch error', e)
                    return ''
                }
            }),
        )
        return results.join('') + spoilerNote
    }
    _getImageFromMessage(message) {
        const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'])
        // Mobile/CDN uploads sometimes arrive without a content type — trust the extension then.
        const isImageAtt = (att) => {
            const ct = (att.contentType ?? '').split(';')[0].trim().toLowerCase()
            if (IMAGE_TYPES.has(ct)) return true
            return /\.(png|jpe?g|webp|gif)$/i.test(att.name ?? '')
        }
        // Collect ALL images, not just the first. Spoiler-tagged attachments
        // are counted but never fetched (see _processTextAttachments).
        const images = []
        let spoilerSkipped = 0
        for (const att of message.attachments.values()) {
            if (att.spoiler) {
                spoilerSkipped++
                continue
            }
            const ct = (att.contentType ?? '').split(';')[0].trim().toLowerCase()
            if (!isImageAtt(att)) continue
            const isGif = ct === 'image/gif' || att.name?.toLowerCase().endsWith('.gif')
            let url = att.proxyURL ?? att.url
            if (isGif && url) url += (url.includes('?') ? '&' : '?') + 'format=webp&width=960'
            images.push({ url, isGif, label: `image ${images.length + 1}` })
        }
        if (images.length > 0) return { ...images[0], allImages: images, spoilerSkipped }

        for (const embed of message.embeds) {
            if (embed.data.type === 'gifv') {
                const thumb = embed.thumbnail?.url
                if (thumb) return { url: thumb, isGif: true, label: 'GIF' }
                const img = embed.image?.url
                if (img) return { url: img, isGif: true, label: 'GIF' }
            } else if (embed.data.type === 'image') {
                const url = embed.url ?? embed.image?.url
                if (url) return { url, isGif: false, label: 'embedded image' }
            } else if (embed.image?.url) {
                return { url: embed.image.url, isGif: false, label: 'embedded image' }
            }
        }

        const ref = message.reference?.resolved
        if (ref) {
            for (const att of ref.attachments.values()) {
                if (att.spoiler) {
                    spoilerSkipped++
                    continue
                }
                const ct = (att.contentType ?? '').split(';')[0].trim().toLowerCase()
                if (!isImageAtt(att)) continue
                const isGif = ct === 'image/gif' || att.name?.toLowerCase().endsWith('.gif')
                let url = att.proxyURL ?? att.url
                if (isGif && url) url += (url.includes('?') ? '&' : '?') + 'format=webp&width=960'
                return { url, isGif, label: 'replied image', spoilerSkipped }
            }
            for (const embed of ref.embeds) {
                if (embed.data.type === 'gifv') {
                    const thumb = embed.thumbnail?.url
                    if (thumb) return { url: thumb, isGif: true, label: 'replied GIF' }
                }
                if (embed.image?.url) return { url: embed.image.url, isGif: false, label: 'replied image' }
            }
        }
        return { url: null, isGif: false, label: null, spoilerSkipped }
    }

    // Stage-1 describe against one specific client+model. Returns {raw, errType};
    // errType 'expired'/'format' are terminal answers, null raw + null errType
    // means "try the next fallback". Key rotation only for the primary.
    async _describeWith(client, model, s1msgs, userText, imageUrl, allowRotate) {
        let raw = null
        let errType = null
        try {
            const r = await client.chat.completions.create({
                model,
                messages: s1msgs,
                max_completion_tokens: this.visionTokens,
                temperature: this.visionTemp,
                top_p: this.topP,
            })
            raw = r.choices[0].message.content
        } catch (e) {
            const err = String(e).toLowerCase()
            if (err.includes('404') && (err.includes('retrieve media') || err.includes('failed to retrieve')))
                errType = 'expired'
            else if (err.includes('400') || err.includes('invalid image') || err.includes('invalid url'))
                errType = 'format'
            else if (this._isCapacityError(e) || this._isRequestError(e)) return { raw: null, errType: null }
            else if (allowRotate) {
                if (this._isKeyError(e)) {
                    if (await this.rotateKey(err)) {
                        try {
                            // rotateKey() rebuilt the shared client around the
                            // fresh key — retry on that, not the stale local
                            // object (same limited key, guaranteed 429).
                            const r2 = await (this._visionClient ?? this._groq).chat.completions.create({
                                model,
                                messages: s1msgs,
                                max_completion_tokens: this.visionTokens,
                                temperature: this.visionTemp,
                                top_p: this.topP,
                            })
                            raw = r2.choices[0].message.content
                        } catch {}
                    }
                }
            }
        }

        // On format/400 error, try once more with the raw URL (no base64), some NVIDIA
        // vision endpoints reject data URLs and need a direct link.
        if (errType === 'format' && imageUrl) {
            try {
                const retryMsgs = [
                    { role: 'system', content: s1msgs[0]?.content ?? '' },
                    {
                        role: 'user',
                        content: [
                            { type: 'image_url', image_url: { url: imageUrl } },
                            { type: 'text', text: userText },
                        ],
                    },
                ]
                const r = await client.chat.completions.create({
                    model,
                    messages: retryMsgs,
                    max_completion_tokens: this.visionTokens,
                    temperature: this.visionTemp,
                    top_p: this.topP,
                })
                raw = r.choices[0].message.content
                errType = null
            } catch (e) {
                console.warn('[AI] Vision raw-URL retry also failed:', String(e).slice(0, 100))
            }
        }
        return { raw, errType }
    }

    async _callVision(
        prompt,
        imageUrl,
        isGif,
        systemPrompt,
        userId = null,
        allImages = null,
        fairCtx = null,
    ) {
        const vclient = this._visionClient ?? this._groq
        if (!vclient && !this.agentFallbacks?.vision?.length) return null
        // Fair-share: one gate per image request (describe + its bounded
        // fallback chain ride under it). Null fairCtx = ungated.
        let fair = null
        if (fairCtx && PERF.ai.fairShare !== false) {
            this._fair ??= new FairQueue()
            fair = await this._fair.acquire({
                guildId: fairCtx.guildId ?? 'dm',
                tokens: estTokens(
                    String(prompt ?? '').length,
                    this.visionTokens ?? 512,
                    allImages?.length ?? 1,
                ),
                priority: fairCtx.priority === true,
            })
            if (!fair.ok) return null
            if (fair.shared) return await fair.shared
        }
        try {
            const gifNote = isGif
                ? "\n\nNote: This is an animated GIF. You can only see the first frame. Describe what you see clearly and precisely, vibe, subject, colours, action. Be honest that it's one frame if movement is implied."
                : ''
            // "read this / ocr / transcribe" asks need verbatim text, not vibes — the
            // describer prompt used to summarize screenshots instead of reading them.
            const ocrIntent =
                /(ocr|transcribe|transcript|extract (the )?text|what does (it|this|that|the image) say|can u( n)? read|\bread\b.*(this|that|it)|check this)/i.test(
                    prompt ?? '',
                )
            const visionSys = ocrIntent
                ? 'You are an OCR engine. Transcribe ALL text visible in the image EXACTLY, character for character, preserving line breaks and layout. Numbers, names, symbols — copy them verbatim, never paraphrase or "fix" them. If part is illegible, mark it [illegible]. If there is genuinely no text, say NONE, then describe the image in one line.' +
                  gifNote
                : 'You are a precise image description assistant. Describe exactly what you see, subjects, actions, text, mood, colours, context. Be detailed and factual. No greetings, no fluff. Just the visual content.' +
                  gifNote
            const imageCount = Math.min(allImages?.length ?? 1, 3)
            const userText = (
                prompt?.trim() ||
                (imageCount > 1
                    ? `Describe all ${imageCount} images in detail.`
                    : isGif
                      ? 'Describe this GIF frame in detail.'
                      : 'Describe this image in detail.')
            ).slice(0, 2000)

            // Download image to base64 so servers don't need to fetch Discord CDN URLs.
            // Capped: providers reject oversized payloads (Groq: 20MB/request — base64
            // inflates ~33%, so ~12MB raw is the safe ceiling), oversized falls back
            // to URL form instead of failing the whole call.
            const MAX_IMG_BYTES = 12 * 1024 * 1024
            // Single-image only: the multi-image batch below re-downloads every
            // URL including the first one, so an eager fetch here would download
            // image #1 twice (sequentially) for zero benefit.
            const multi = (allImages?.length ?? 0) > 1
            let imageContent = null
            if (!multi) {
                try {
                    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(10_000) })
                    if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`)
                    const contentType =
                        imgRes.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/jpeg'
                    const buffer = await imgRes.arrayBuffer()
                    if (buffer.byteLength > MAX_IMG_BYTES)
                        throw new Error(`too large (${(buffer.byteLength / 1048576).toFixed(1)}MB)`)
                    const base64 = Buffer.from(buffer).toString('base64')
                    imageContent = { type: 'base64', media_type: contentType, data: base64 }
                } catch (e) {
                    console.warn('[AI] Image fetch failed, falling back to URL:', String(e).slice(0, 100))
                    imageContent = null
                }
            }

            const imageBlock = imageContent
                ? {
                      type: 'image_url',
                      image_url: { url: `data:${imageContent.media_type};base64,${imageContent.data}` },
                  }
                : { type: 'image_url', image_url: { url: imageUrl } }

            // Build content array with all images if multiple were sent. Capped at 3:
            // providers limit images per request (Groq: 3) and a 4th errors the call.
            const imageBlocks =
                allImages && allImages.length > 1
                    ? await Promise.all(
                          allImages.slice(0, 3).map(async (img) => {
                              // Download each image to base64
                              try {
                                  const imgRes = await fetch(img.url, { signal: AbortSignal.timeout(10_000) })
                                  if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`)
                                  const ct =
                                      imgRes.headers.get('content-type')?.split(';')[0]?.trim() ??
                                      'image/jpeg'
                                  const buf = await imgRes.arrayBuffer()
                                  if (buf.byteLength > MAX_IMG_BYTES) throw new Error('too large')
                                  const b64 = Buffer.from(buf).toString('base64')
                                  return { type: 'image_url', image_url: { url: `data:${ct};base64,${b64}` } }
                              } catch {
                                  return { type: 'image_url', image_url: { url: img.url } }
                              }
                          }),
                      )
                    : [imageBlock]

            const s1msgs = [
                { role: 'system', content: visionSys },
                {
                    role: 'user',
                    content: [
                        ...imageBlocks,
                        {
                            type: 'text',
                            text:
                                imageBlocks.length > 1
                                    ? `There are ${imageBlocks.length} images above. ${userText}`
                                    : userText,
                        },
                    ],
                },
            ]
            let raw = null
            let errType = null
            // GIFs must be requested as a static frame everywhere, including the
            // raw-URL retry inside _describeWith: some vision endpoints 400 on
            // animated GIF URLs ("animated GIFs are not supported").
            const staticUrl =
                isGif && imageUrl && !/[?&]format=webp/.test(imageUrl)
                    ? imageUrl + (imageUrl.includes('?') ? '&' : '?') + 'format=webp&width=960'
                    : imageUrl
            const primary = this._visionClient ?? this._groq
            if (primary)
                ({ raw, errType } = await this._describeWith(
                    primary,
                    this.visionModel,
                    s1msgs,
                    userText,
                    staticUrl,
                    // Only the chat-provider client may rotate the chat ring.
                    // A pinned vision client (own provider/key) rotating it
                    // cools down chat keys the vision call never uses.
                    !this._visionClient,
                ))
            // Hard failure (not expired/format, which are terminal answers) -> walk
            // this agent's own fallback chain before giving up to text-only.
            if (!raw && !errType) {
                for (const fb of this.agentFallbacks?.vision ?? []) {
                    try {
                        const client = this._fallbackClient(fb)
                        if (!client) continue
                        const att = await this._describeWith(
                            client,
                            fb.model,
                            s1msgs,
                            userText,
                            staticUrl,
                            false,
                        )
                        if (att.raw || att.errType) {
                            if (att.raw)
                                console.log(
                                    `[AI] Vision fallback answered via ${fb.provider ?? fb.baseUrl} / ${fb.model}`,
                                )
                            raw = att.raw
                            errType = att.errType
                            break
                        }
                    } catch {}
                }
            }

            if (errType === 'expired')
                return "that image link seems to have expired or isn't loading for me 😅"
            if (errType === 'format') return "hmm i couldn't process that image format 🤔"
            if (!raw) {
                // Vision failed but we got a prompt, answer without the image
                return await this.generateResponse({
                    prompt: prompt?.trim() || 'Describe what you see.',
                    userId,
                })
            }

            // Stage 2, rewrite
            const mediaLabel = isGif ? 'GIF (first frame)' : 'image'
            const kSys =
                (systemPrompt || this.instructions || '') +
                '\n\nDISCORD FORMATTING, use purposefully:\n**bold** key things you notice · *italic* for vibe/tone · `code` for any text/numbers in the image · -# for small captions · lists only if genuinely listing multiple distinct things'
            const kPrompt =
                `You just saw a ${mediaLabel}. Here's what it contains:\n${'─'.repeat(36)}\n${raw}\n${'─'.repeat(36)}\n\n` +
                (prompt?.trim() ? `The user asked: ${prompt.trim()}\n\n` : '') +
                `Respond naturally as Medusa, react genuinely to what you see. If it's funny, be amused. If it's beautiful, say so. If it's weird, own that reaction. Use Discord markdown sparingly for key details. Never say 'according to the description' or 'the image shows', speak as if you're seeing it yourself, in first person.`
            const final = await this.generateResponse({
                prompt: kPrompt,
                history: null,
                userId,
                systemPrompt: kSys,
            })
            return final ?? raw
        } finally {
            fair?.release?.()
        }
    }
}
