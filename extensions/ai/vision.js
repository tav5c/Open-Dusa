// Vision layer: image extraction from messages/replies, text-attachment
// ingestion, and the two-stage vision call (describe -> persona rewrite).
import { ResearchCore } from './research.js'

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
        const textAtts = [...message.attachments.values()].filter((att) => {
            const ct = (att.contentType ?? '').toLowerCase()
            const ext = att.name?.split('.').pop()?.toLowerCase()
            return ct.includes('text/') || TEXT_EXTS.has('.' + ext)
        })
        if (!textAtts.length) return ''
        const totalSize = textAtts.reduce((sum, att) => sum + att.size, 0)
        if (totalSize > 150_000)
            return `\n\n[${textAtts.length} file(s) skipped — combined size ${(totalSize / 1024).toFixed(0)}KB exceeds limit]`
        // Fetch all text attachments in parallel
        const results = await Promise.all(
            textAtts.map(async (att) => {
                if (att.size > 80_000)
                    return `\n\n[File: \`${att.name}\` — too large to read (${(att.size / 1024).toFixed(0)}KB)]`
                try {
                    const res = await fetch(att.url)
                    const text = await res.text()
                    return `\n\n[Attached File: ${att.name}]\n\`\`\`\n${text.slice(0, 10000)}\n\`\`\``
                } catch (e) {
                    console.error('[AI] Text fetch error', e)
                    return ''
                }
            }),
        )
        return results.join('')
    }
    _getImageFromMessage(message) {
        const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'])
        // Collect ALL images, not just the first
        const images = []
        for (const att of message.attachments.values()) {
            const ct = (att.contentType ?? '').split(';')[0].trim().toLowerCase()
            if (!IMAGE_TYPES.has(ct)) continue
            const isGif = ct === 'image/gif' || att.name?.toLowerCase().endsWith('.gif')
            let url = att.proxyURL ?? att.url
            if (isGif && url) url += (url.includes('?') ? '&' : '?') + 'format=webp&width=960'
            images.push({ url, isGif, label: `image ${images.length + 1}` })
        }
        if (images.length > 0) return { ...images[0], allImages: images }

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
                const ct = (att.contentType ?? '').split(';')[0].trim().toLowerCase()
                if (!IMAGE_TYPES.has(ct)) continue
                const isGif = ct === 'image/gif' || att.name?.toLowerCase().endsWith('.gif')
                let url = att.proxyURL ?? att.url
                if (isGif && url) url += (url.includes('?') ? '&' : '?') + 'format=webp&width=960'
                return { url, isGif, label: 'replied image' }
            }
            for (const embed of ref.embeds) {
                if (embed.data.type === 'gifv') {
                    const thumb = embed.thumbnail?.url
                    if (thumb) return { url: thumb, isGif: true, label: 'replied GIF' }
                }
                if (embed.image?.url) return { url: embed.image.url, isGif: false, label: 'replied image' }
            }
        }
        return { url: null, isGif: false, label: null }
    }

    async _callVision(prompt, imageUrl, isGif, systemPrompt, userId = null, allImages = null) {
        const vclient = this._visionClient ?? this._groq
        if (!vclient) return null
        const gifNote = isGif
            ? "\n\nNote: This is an animated GIF. You can only see the first frame. Describe what you see clearly and precisely — vibe, subject, colours, action. Be honest that it's one frame if movement is implied."
            : ''
        const visionSys =
            'You are a precise image description assistant. Describe exactly what you see — subjects, actions, text, mood, colours, context. Be detailed and factual. No greetings, no fluff. Just the visual content.' +
            gifNote
        const imageCount = allImages?.length ?? 1
        const userText = (
            prompt?.trim() ||
            (imageCount > 1
                ? `Describe all ${imageCount} images in detail.`
                : isGif
                  ? 'Describe this GIF frame in detail.'
                  : 'Describe this image in detail.')
        ).slice(0, 2000)

        // Download image to base64 so servers don't need to fetch Discord CDN URLs
        let imageContent
        try {
            const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(10_000) })
            if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`)
            const contentType = imgRes.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/jpeg'
            const buffer = await imgRes.arrayBuffer()
            const base64 = Buffer.from(buffer).toString('base64')
            imageContent = { type: 'base64', media_type: contentType, data: base64 }
        } catch (e) {
            console.warn('[AI] Image fetch failed, falling back to URL:', String(e).slice(0, 100))
            imageContent = null
        }

        const imageBlock = imageContent
            ? {
                  type: 'image_url',
                  image_url: { url: `data:${imageContent.media_type};base64,${imageContent.data}` },
              }
            : { type: 'image_url', image_url: { url: imageUrl } }

        // Build content array with all images if multiple were sent
        const imageBlocks =
            allImages && allImages.length > 1
                ? await Promise.all(
                      allImages.slice(0, 4).map(async (img) => {
                          // Download each image to base64
                          try {
                              const imgRes = await fetch(img.url, { signal: AbortSignal.timeout(10_000) })
                              if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`)
                              const ct =
                                  imgRes.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/jpeg'
                              const buf = await imgRes.arrayBuffer()
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
        try {
            const r = await vclient.chat.completions.create({
                model: this.visionModel,
                messages: s1msgs,
                max_completion_tokens: this.visionTokens,
                temperature: this.visionTemp,
                top_p: this.topP,
            })
            raw = r.choices[0].message.content
            this.keyFailures[this.currentKeyIdx] = 0
        } catch (e) {
            const err = String(e).toLowerCase()
            if (err.includes('404') && (err.includes('retrieve media') || err.includes('failed to retrieve')))
                errType = 'expired'
            else if (err.includes('400') || err.includes('invalid image') || err.includes('invalid url'))
                errType = 'format'
            else if (this._isCapacityError(err)) return null
            else {
                this.keyFailures[this.currentKeyIdx] = (this.keyFailures[this.currentKeyIdx] ?? 0) + 1
                if (this._isRateError(err) || this.keyFailures[this.currentKeyIdx] >= this.maxFailures) {
                    if (await this.rotateKey(err)) {
                        try {
                            const r2 = await vclient.chat.completions.create({
                                model: this.visionModel,
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

        // On format/400 error, try once more with the raw URL (no base64) — some NVIDIA
        // vision endpoints reject data URLs and need a direct link.
        if (errType === 'format' && imageUrl) {
            try {
                const retryMsgs = [
                    { role: 'system', content: visionSys },
                    {
                        role: 'user',
                        content: [
                            { type: 'image_url', image_url: { url: imageUrl } },
                            { type: 'text', text: userText },
                        ],
                    },
                ]
                const r = await vclient.chat.completions.create({
                    model: this.visionModel,
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

        if (errType === 'expired') return "that image link seems to have expired or isn't loading for me 😅"
        if (errType === 'format') return "hmm i couldn't process that image format 🤔"
        if (!raw) {
            // Vision failed but we got a prompt — answer without the image
            return await this.generateResponse({ prompt: prompt?.trim() || 'Describe what you see.', userId })
        }

        // Stage 2 — rewrite
        const mediaLabel = isGif ? 'GIF (first frame)' : 'image'
        const kSys =
            (systemPrompt || this.instructions || '') +
            '\n\nDISCORD FORMATTING — use purposefully:\n**bold** key things you notice · *italic* for vibe/tone · `code` for any text/numbers in the image · -# for small captions · lists only if genuinely listing multiple distinct things'
        const kPrompt =
            `You just saw a ${mediaLabel}. Here's what it contains:\n${'─'.repeat(36)}\n${raw}\n${'─'.repeat(36)}\n\n` +
            (prompt?.trim() ? `The user asked: ${prompt.trim()}\n\n` : '') +
            `Respond naturally as Medusa — react genuinely to what you see. If it's funny, be amused. If it's beautiful, say so. If it's weird, own that reaction. Use Discord markdown sparingly for key details. Never say 'according to the description' or 'the image shows' — speak as if you're seeing it yourself, in first person.`
        const final = await this.generateResponse({
            prompt: kPrompt,
            history: null,
            userId,
            systemPrompt: kSys,
        })
        return final ?? raw
    }
}
