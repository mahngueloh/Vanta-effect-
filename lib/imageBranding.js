'use strict'

const sharp  = require('sharp')

// This host runs on a tight memory budget — libvips' default operation
// cache (up to 50MB + up to 100 cached images) is pure overhead for a bot
// that brands one news image every so often rather than serving a stream of
// requests. Capping it shrinks the bot's steady-state memory footprint.
sharp.cache({ memory: 15, files: 0, items: 20 })
sharp.concurrency(1)
const axios  = require('axios')
const path   = require('path')
const fs     = require('fs')
const config = require('../config')

// ── Real logo asset (user-supplied) ─────────────────────────────────────────
// Path to the actual MAHNGUELOH NEWS logo image, cropped from the brand guide
// the owner uploaded. Used as a real watermark instead of a hand-drawn SVG
// approximation. Falls back to the SVG-drawn badge if the file is missing.
const LOGO_ASSET_PATH = path.join(__dirname, '..', 'assets', 'logo.png')
let logoAssetBuffer = null
let logoAssetChecked = false

function getLogoAssetBuffer() {
    if (!logoAssetChecked) {
        logoAssetChecked = true
        try {
            logoAssetBuffer = fs.readFileSync(LOGO_ASSET_PATH)
        } catch {
            logoAssetBuffer = null
        }
    }
    return logoAssetBuffer
}

const TARGET_WIDTH       = 1080
const MAX_PHOTO_HEIGHT   = 660
const MIN_SOURCE_WIDTH   = 320   // reject icons/tracking-pixel images below this
const MIN_SOURCE_HEIGHT  = 180
const FOOTER_HEIGHT      = 330   // tall enough for summary + info bar + slogan
const FETCH_TIMEOUT_MS   = 15000
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024

// ── Brand colours ────────────────────────────────────────────────────────────
const GOLD    = '#FFD700'
const RED     = '#C8000A'
const WHITE   = '#FFFFFF'
const DARK_BG = '#111111'
const BLACK   = '#0d0d0d'

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeXml(str = '') {
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&apos;')
}

function charWidth(fontSize) { return fontSize * 0.60 }

function wrapText(text, maxWidth, fontSize) {
    const words = String(text).split(/\s+/).filter(Boolean)
    const lines = []
    let cur = ''
    for (const word of words) {
        const candidate = cur ? `${cur} ${word}` : word
        if (candidate.length * charWidth(fontSize) > maxWidth && cur) {
            lines.push(cur)
            cur = word
        } else {
            cur = candidate
        }
    }
    if (cur) lines.push(cur)
    return lines
}

function fitHeadline(text, maxWidth, maxLines = 5) {
    let fontSize = 56
    let lines = wrapText(text, maxWidth, fontSize)
    while (lines.length > maxLines && fontSize > 28) {
        fontSize -= 2
        lines = wrapText(text, maxWidth, fontSize)
    }
    return { fontSize, lines }
}

// ── SVG builders ─────────────────────────────────────────────────────────────

function buildGradientSvg(W, H) {
    return Buffer.from(
        `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stop-color="#000" stop-opacity="0.00"/>
                    <stop offset="25%"  stop-color="#000" stop-opacity="0.20"/>
                    <stop offset="60%"  stop-color="#000" stop-opacity="0.70"/>
                    <stop offset="100%" stop-color="#000" stop-opacity="0.95"/>
                </linearGradient>
            </defs>
            <rect width="${W}" height="${H}" fill="url(#g)"/>
        </svg>`
    )
}

function buildBreakingBadgeSvg() {
    const W = 310, H = 48
    return {
        svg: Buffer.from(
            `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
                <rect width="${W}" height="${H}" fill="${RED}"/>
                <text x="16" y="33"
                      font-family="Arial Black, Arial, sans-serif"
                      font-weight="900" font-size="21" fill="${WHITE}" letter-spacing="2">BREAKING NEWS  //</text>
            </svg>`
        ),
        width: W, height: H,
    }
}

function buildLogoBadgeSvg() {
    const S  = 148   // bounding box
    const cx = S / 2, cy = S / 2
    const r  = S / 2 - 4   // outer ring radius

    // Globe arc centre is slightly above the M centre, smaller than the ring
    const gr = 30   // globe radius
    const gx = cx, gy = cy - 10

    return {
        svg: Buffer.from(
            `<svg width="${S}" height="${S}" xmlns="http://www.w3.org/2000/svg">

                <!-- dark fill + gold outer ring -->
                <circle cx="${cx}" cy="${cy}" r="${r}"
                        fill="${BLACK}" fill-opacity="0.88"
                        stroke="${GOLD}" stroke-width="3"/>

                <!-- inner thin ring (design detail from reference) -->
                <circle cx="${cx}" cy="${cy}" r="${r - 6}"
                        fill="none" stroke="${GOLD}" stroke-width="0.8" stroke-opacity="0.35"/>

                <!-- globe wireframe behind M (subtle gold lines) -->
                <!-- equator -->
                <line x1="${gx - gr}" y1="${gy}" x2="${gx + gr}" y2="${gy}"
                      stroke="${GOLD}" stroke-width="1" stroke-opacity="0.40"/>
                <!-- upper latitude -->
                <ellipse cx="${gx}" cy="${gy - 11}" rx="${gr * 0.85}" ry="7"
                         fill="none" stroke="${GOLD}" stroke-width="0.9" stroke-opacity="0.35"/>
                <!-- lower latitude -->
                <ellipse cx="${gx}" cy="${gy + 11}" rx="${gr * 0.85}" ry="7"
                         fill="none" stroke="${GOLD}" stroke-width="0.9" stroke-opacity="0.35"/>
                <!-- central meridian arc -->
                <ellipse cx="${gx}" cy="${gy}" rx="12" ry="${gr}"
                         fill="none" stroke="${GOLD}" stroke-width="0.9" stroke-opacity="0.35"/>

                <!-- "M" lettermark — centred, bold gold -->
                <text x="${cx}" y="${cy + 6}"
                      text-anchor="middle" dominant-baseline="middle"
                      font-family="Arial Black, Arial, sans-serif"
                      font-weight="900" font-size="58" fill="${GOLD}">M</text>

                <!-- MAHNGUELOH label -->
                <text x="${cx}" y="${cy + 42}"
                      text-anchor="middle"
                      font-family="Arial, sans-serif"
                      font-weight="700" font-size="11" fill="${WHITE}" letter-spacing="2.2">MAHNGUELOH</text>

                <!-- NEWS label -->
                <text x="${cx}" y="${cy + 56}"
                      text-anchor="middle"
                      font-family="Arial, sans-serif"
                      font-weight="700" font-size="11" fill="${GOLD}" letter-spacing="3.5">NEWS</text>
            </svg>`
        ),
        size: S,
    }
}

function buildCategoryTagSvg(category) {
    const text = escapeXml((category || '').toUpperCase())
    const padX = 22
    const W    = Math.round(text.length * 14 + padX * 2)
    const H    = 42
    return {
        svg: Buffer.from(
            `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
                <rect width="${W}" height="${H}" fill="${GOLD}"/>
                <text x="${W / 2}" y="${H - 10}"
                      text-anchor="middle"
                      font-family="Arial Black, Arial, sans-serif"
                      font-weight="900" font-size="19" fill="${BLACK}" letter-spacing="2">${text}</text>
            </svg>`
        ),
        width: W, height: H,
    }
}

function buildHeadlineSvg(W, lines, fontSize) {
    const LH     = Math.round(fontSize * 1.20)
    const PAD_X  = 28
    const totalH = lines.length * LH + 28

    const textEls = lines.map((line, i) => {
        const y    = 20 + (i + 0.85) * LH
        const fill = (i === lines.length - 1) ? GOLD : WHITE
        return `<text x="${PAD_X}" y="${y}"
                    font-family="Arial Black, Arial, sans-serif"
                    font-weight="900" font-size="${fontSize}"
                    fill="${fill}">${escapeXml(line)}</text>`
    }).join('\n')

    return {
        svg: Buffer.from(
            `<svg width="${W}" height="${totalH}" xmlns="http://www.w3.org/2000/svg">
                ${textEls}
            </svg>`
        ),
        height: totalH,
    }
}

function domainFromUrl(url) {
    if (!url) return ''
    try {
        return new URL(url).hostname.replace(/^www\./, '')
    } catch {
        return String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
    }
}

function buildFooterSvg(W, H, { summary, dateStr, socialHandle, slogan, sourceName, sourceUrl }) {
    const PAD   = 36
    const innerW = W - PAD * 2

    // ── 1. Summary ───────────────────────────────────────────────────────────
    const sumFS    = 20
    const sumLH    = 30
    const sumLines = summary ? wrapText(summary, innerW, sumFS).slice(0, 3) : []
    const sumBlockH = sumLines.length ? sumLines.length * sumLH + 4 : 0

    const summaryEls = sumLines.map((line, i) =>
        `<text x="${PAD}" y="${PAD + (i + 1) * sumLH - 4}"
               font-family="Arial, sans-serif" font-size="${sumFS}"
               fill="${WHITE}" fill-opacity="0.90">${escapeXml(line)}</text>`
    ).join('\n')

    // ── 2. Gold divider ──────────────────────────────────────────────────────
    const divY = PAD + sumBlockH + 10

    // ── 3. Info bar coordinates ───────────────────────────────────────────────
    //  Left zone:  PAD … W * 0.33
    //  Centre zone: W * 0.33 … W * 0.67
    //  Right zone:  W * 0.67 … W - PAD

    const infoTopY = divY + 22          // top of info bar
    const infoFS   = 17                 // font size for date text

    // Date — two lines stacked
    const dateParts  = (dateStr || '').split(/\s{2,}|\//)   // split on double-space or slash
    const dateLine1  = escapeXml((dateParts[0] || dateStr || '').trim())
    const dateLine2  = escapeXml((dateParts[1] || '').trim())

    const calIconX  = PAD + 2
    const calIconY  = infoTopY
    const calSize   = 22
    const dateTextX = calIconX + calSize + 8
    const dateY1    = infoTopY + 16
    const dateY2    = dateY1 + 22

    // Centre — "Read more on <source>" with a small globe icon, matching the
    // reference layout. Falls back to the brand name if no source is known.
    const sourceLabel = (sourceName || domainFromUrl(sourceUrl) || 'MAHNGUELOH NEWS')
    const globeCx = W / 2 - (charWidth(14) * (`Read more on ${sourceLabel}`.length)) / 2 - 14
    const globeCy = infoTopY + 11
    const globeR  = 11
    const sourceTextX = globeCx + globeR + 10
    const brandY = infoTopY + 16

    // Social icons — right-aligned, 28×28 each, 7px gap
    const iconW   = 28, iconH = 28, iconGap = 7
    const icons   = [
        { label: 'f',  bg: '#1877F2' },
        { label: 'ig', bg: '#C13584' },
        { label: 'X',  bg: '#000000' },
        { label: 'tt', bg: '#010101' },
    ]
    const iconsBlockW = icons.length * iconW + (icons.length - 1) * iconGap
    const iconsX      = W - PAD - iconsBlockW
    const iconsY      = infoTopY

    const iconEls = icons.map((ic, i) => {
        const ix = iconsX + i * (iconW + iconGap)
        const iy = iconsY
        const fs = ic.label.length > 1 ? 12 : 16
        return `
        <rect x="${ix}" y="${iy}" width="${iconW}" height="${iconH}" rx="5" fill="${ic.bg}"/>
        <text x="${ix + iconW / 2}" y="${iy + iconH / 2 + 5}"
              text-anchor="middle"
              font-family="Arial Black, Arial, sans-serif"
              font-weight="900" font-size="${fs}" fill="${WHITE}">${ic.label}</text>`
    }).join('\n')

    const handleOut = escapeXml(socialHandle || '@mahnguelohnews')
    const handleY   = iconsY + iconH + 20

    // ── 4. Thin separator + slogan ────────────────────────────────────────────
    // Place separator so slogan has ~46px of padding at the bottom
    const sepY     = H - 64
    const sloganY  = H - 22
    const sloganStr = escapeXml(slogan || 'FAST. ACCURATE. TRENDING.')

    // ── Calendar icon (SVG mini-calendar shape) ───────────────────────────────
    const calX2 = calIconX + calSize, calY2 = calIconY + calSize
    const calHeaderLine = calIconY + 8
    const calendarSvg = `
        <rect x="${calIconX}" y="${calIconY}" width="${calSize}" height="${calSize}"
              rx="3" fill="none" stroke="${GOLD}" stroke-width="1.5" stroke-opacity="0.80"/>
        <line x1="${calIconX + 6}" y1="${calIconY - 2}" x2="${calIconX + 6}" y2="${calIconY + 7}"
              stroke="${GOLD}" stroke-width="1.5" stroke-opacity="0.80"/>
        <line x1="${calIconX + calSize - 6}" y1="${calIconY - 2}" x2="${calIconX + calSize - 6}" y2="${calIconY + 7}"
              stroke="${GOLD}" stroke-width="1.5" stroke-opacity="0.80"/>
        <line x1="${calIconX}" y1="${calHeaderLine}" x2="${calX2}" y2="${calHeaderLine}"
              stroke="${GOLD}" stroke-width="1.2" stroke-opacity="0.60"/>`

    return Buffer.from(
        `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">

            <!-- dark background -->
            <rect width="${W}" height="${H}" fill="${DARK_BG}"/>

            <!-- ── Summary ── -->
            ${summaryEls}

            <!-- ── Gold divider ── -->
            <line x1="${PAD}" y1="${divY}" x2="${W - PAD}" y2="${divY}"
                  stroke="${GOLD}" stroke-width="2" stroke-opacity="0.60"/>

            <!-- ── LEFT: calendar icon + date ── -->
            ${calendarSvg}
            <text x="${dateTextX}" y="${dateY1}"
                  font-family="Arial, sans-serif" font-size="${infoFS}" font-weight="700"
                  fill="${WHITE}" fill-opacity="0.85">${dateLine1}</text>
            ${dateLine2 ? `<text x="${dateTextX}" y="${dateY2}"
                  font-family="Arial, sans-serif" font-size="${infoFS - 1}"
                  fill="${WHITE}" fill-opacity="0.65">${dateLine2}</text>` : ''}

            <!-- ── CENTRE: globe icon + source ── -->
            <circle cx="${globeCx}" cy="${globeCy}" r="${globeR}"
                    fill="none" stroke="${GOLD}" stroke-width="1.4" stroke-opacity="0.85"/>
            <line x1="${globeCx - globeR}" y1="${globeCy}" x2="${globeCx + globeR}" y2="${globeCy}"
                  stroke="${GOLD}" stroke-width="1" stroke-opacity="0.65"/>
            <ellipse cx="${globeCx}" cy="${globeCy}" rx="${globeR * 0.45}" ry="${globeR}"
                     fill="none" stroke="${GOLD}" stroke-width="1" stroke-opacity="0.65"/>
            <text x="${sourceTextX}" y="${brandY}"
                  font-family="Arial, sans-serif" font-size="14" font-weight="700"
                  fill="${WHITE}" fill-opacity="0.90">Read more on <tspan fill="${GOLD}">${escapeXml(sourceLabel)}</tspan></text>

            <!-- ── RIGHT: social icons ── -->
            ${iconEls}

            <!-- social handle below icons -->
            <text x="${iconsX + iconsBlockW / 2}" y="${handleY}" text-anchor="middle"
                  font-family="Arial, sans-serif" font-size="15"
                  fill="${GOLD}">${handleOut}</text>

            <!-- ── Thin separator ── -->
            <line x1="0" y1="${sepY}" x2="${W}" y2="${sepY}"
                  stroke="${GOLD}" stroke-width="1" stroke-opacity="0.30"/>

            <!-- ── Slogan ── -->
            <text x="${W / 2}" y="${sloganY}" text-anchor="middle"
                  font-family="Arial Black, Arial, sans-serif"
                  font-weight="900" font-size="22" fill="${GOLD}" letter-spacing="5">${sloganStr}</text>
        </svg>`
    )
}

// ── Image download ────────────────────────────────────────────────────────────

async function downloadImage(imageUrl) {
    const res = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: FETCH_TIMEOUT_MS,
        maxContentLength: MAX_DOWNLOAD_BYTES,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MAHNGUELOH VANTA NewsBot/1.0)' },
    })
    return Buffer.from(res.data)
}

function buildFallbackBackground(W, H) {
    // Diagonal gold lines spaced evenly across the canvas
    const lineSpacing = 90
    const diagLines = []
    for (let i = -(H); i < W + H; i += lineSpacing) {
        diagLines.push(
            `<line x1="${i}" y1="0" x2="${i + H}" y2="${H}"
                   stroke="${GOLD}" stroke-width="0.5" stroke-opacity="0.07"/>`
        )
    }
    return Buffer.from(
        `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
            <!-- base dark background -->
            <rect width="${W}" height="${H}" fill="#090909"/>
            <!-- subtle diagonal grid lines -->
            ${diagLines.join('\n')}
            <!-- thin horizontal accent line at 28% -->
            <line x1="0" y1="${Math.round(H * 0.28)}" x2="${W}" y2="${Math.round(H * 0.28)}"
                  stroke="${GOLD}" stroke-width="1.2" stroke-opacity="0.10"/>
            <!-- faint large M watermark — fills upper half -->
            <text x="${W / 2}" y="${Math.round(H * 0.60)}"
                  text-anchor="middle" dominant-baseline="middle"
                  font-family="Arial Black, Arial, sans-serif" font-weight="900"
                  font-size="420" fill="${GOLD}" opacity="0.045">M</text>
            <!-- gradient overlay — darkens bottom for headline readability -->
            <defs>
                <linearGradient id="fbg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stop-color="#000" stop-opacity="0.10"/>
                    <stop offset="50%"  stop-color="#000" stop-opacity="0.45"/>
                    <stop offset="100%" stop-color="#000" stop-opacity="0.88"/>
                </linearGradient>
            </defs>
            <rect width="${W}" height="${H}" fill="url(#fbg)"/>
        </svg>`
    )
}

// ── Main export ───────────────────────────────────────────────────────────────

async function brandArticleImage(imageUrl, headline, opts = {}) {
    const branding = config.news?.branding || {}

    try {
        let photoBuf
        let W      = TARGET_WIDTH
        let photoH = MAX_PHOTO_HEIGHT

        if (imageUrl) {
            // ── 1a. Download real photo ───────────────────────────────────────
            let raw, rawMeta
            try {
                raw = await downloadImage(imageUrl)
                rawMeta = await sharp(raw).rotate().metadata()
            } catch (e) {
                const status = e.response?.status
                throw new Error(status ? `download failed (HTTP ${status})` : `download failed (${e.message})`)
            }

            // Reject undersized/low-quality source images (icons, tracking
            // pixels, tiny thumbnails pulled from article HTML). Forcing these
            // to fill a 1080×660 box would either look pixelated or, worse,
            // produce a very short photo band that leaves no room for the
            // headline — which is exactly what caused the broken/overlapping
            // layout (headline slammed into the logo, footer text crammed).
            if ((rawMeta.width || 0) < MIN_SOURCE_WIDTH || (rawMeta.height || 0) < MIN_SOURCE_HEIGHT) {
                throw new Error(`image too small (${rawMeta.width}x${rawMeta.height})`)
            }

            // ── 1b. Force a fixed photo box every time ────────────────────────
            // Using fit:'cover' (crop-to-fill) instead of a width-only resize
            // means every post gets the exact same TARGET_WIDTH × MAX_PHOTO_HEIGHT
            // photo band, no matter the source image's native aspect ratio.
            // This is what keeps every post looking like the clean reference
            // layout instead of varying wildly per source.
            photoBuf = await sharp(raw)
                .rotate()
                .resize({
                    width: TARGET_WIDTH,
                    height: MAX_PHOTO_HEIGHT,
                    fit: 'cover',
                    position: 'attention',   // crop toward the most "interesting" region
                })
                .toBuffer()
            photoH = MAX_PHOTO_HEIGHT
        } else {
            // ── 1b. No photo — use branded dark fallback background ───────────
            const fallbackSvg = buildFallbackBackground(W, photoH)
            photoBuf = await sharp(fallbackSvg)
                .png()
                .toBuffer()
        }

        const totalH     = photoH + FOOTER_HEIGHT
        const composites = []

        // ── 2. Photo layer ────────────────────────────────────────────────────
        composites.push({ input: photoBuf, top: 0, left: 0 })

        // ── 3. Dark gradient overlay ──────────────────────────────────────────
        composites.push({ input: buildGradientSvg(W, photoH), top: 0, left: 0 })

        // ── 4. BREAKING NEWS badge — top-left ─────────────────────────────────
        if (opts.isBreaking) {
            const badge = buildBreakingBadgeSvg()
            composites.push({ input: badge.svg, top: 26, left: 26 })
        }

        // ── 5. MAHNGUELOH NEWS logo — top-right ───────────────────────────────
        const showLogo = opts.watermark ?? branding.watermarkEnabled ?? true
        if (showLogo) {
            const realLogo = getLogoAssetBuffer()
            if (realLogo) {
                // Use the real uploaded logo image, resized to the same
                // footprint the old SVG badge used, with a thin gold ring
                // behind it so it still pops against light photos.
                const logoSize = 148
                const ringSvg = Buffer.from(
                    `<svg width="${logoSize}" height="${logoSize}" xmlns="http://www.w3.org/2000/svg">
                        <circle cx="${logoSize / 2}" cy="${logoSize / 2}" r="${logoSize / 2 - 2}"
                                fill="${BLACK}" fill-opacity="0.55"
                                stroke="${GOLD}" stroke-width="3"/>
                    </svg>`
                )
                const logoResized = await sharp(realLogo)
                    .resize(logoSize - 14, logoSize - 14, { fit: 'cover' })
                    .toBuffer()
                const logoTop  = 16
                const logoLeft = W - logoSize - 18
                composites.push({ input: ringSvg, top: logoTop, left: logoLeft })
                composites.push({ input: logoResized, top: logoTop + 7, left: logoLeft + 7 })
            } else {
                // Fallback: hand-drawn SVG badge (used only if the logo asset is missing)
                const logo = buildLogoBadgeSvg()
                composites.push({ input: logo.svg, top: 16, left: W - logo.size - 18 })
            }
        }

        // ── 6. Category tag + headline — bottom of photo area ─────────────────
        const PAD_X  = 28
        const innerW = W - PAD_X * 2

        const { fontSize, lines } = fitHeadline(headline || '', innerW)
        const headlineSvg = buildHeadlineSvg(W, lines, fontSize)

        const category = opts.category || branding.defaultCategory || ''
        const catTag   = category ? buildCategoryTagSvg(category) : null
        const catH     = catTag ? catTag.height + 14 : 0

        const textBlockH  = catH + headlineSvg.height
        const maxTextStart = Math.max(photoH - textBlockH - 4, 4)
        const idealStart   = photoH - textBlockH - 24
        const textStartY   = Math.min(Math.max(idealStart, 4), maxTextStart)

        if (photoH >= 120) {
            if (catTag) {
                composites.push({ input: catTag.svg, top: textStartY, left: PAD_X })
            }
            composites.push({ input: headlineSvg.svg, top: textStartY + catH, left: 0 })
        }

        // ── 7. Footer section ─────────────────────────────────────────────────
        const dateStr = opts.dateStr
            || new Date().toLocaleDateString('en-GB', {
                day: '2-digit', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
                timeZone: config.timezone || 'Africa/Nairobi',
            })

        const footerSvg = buildFooterSvg(W, FOOTER_HEIGHT, {
            summary:      opts.summary || '',
            dateStr,
            socialHandle: branding.socialHandle || '@mahnguelohnews',
            slogan:       branding.slogan        || 'FAST. ACCURATE. TRENDING.',
            sourceName:   opts.sourceName || '',
            sourceUrl:    opts.sourceUrl  || '',
        })
        composites.push({ input: footerSvg, top: photoH, left: 0 })

        // ── 8. Compose ─────────────────────────────────────────────────────────
        const flat = await sharp({
            create: { width: W, height: totalH, channels: 4, background: { r: 17, g: 17, b: 17, alpha: 1 } },
        })
            .composite(composites)
            .png()
            .toBuffer()

        // ── 9. Rounded corners + gold border, then flatten to JPEG ────────────
        const RADIUS = 28
        const roundedMask = Buffer.from(
            `<svg width="${W}" height="${totalH}" xmlns="http://www.w3.org/2000/svg">
                <rect x="0" y="0" width="${W}" height="${totalH}" rx="${RADIUS}" ry="${RADIUS}" fill="#fff"/>
            </svg>`
        )
        const borderOverlay = Buffer.from(
            `<svg width="${W}" height="${totalH}" xmlns="http://www.w3.org/2000/svg">
                <rect x="1.5" y="1.5" width="${W - 3}" height="${totalH - 3}" rx="${RADIUS}" ry="${RADIUS}"
                      fill="none" stroke="${GOLD}" stroke-width="3" stroke-opacity="0.85"/>
            </svg>`
        )

        const rounded = await sharp(flat)
            .composite([{ input: roundedMask, blend: 'dest-in' }])
            .png()
            .toBuffer()

        const output = await sharp({
            create: { width: W, height: totalH, channels: 3, background: { r: 17, g: 17, b: 17 } },
        })
            .composite([{ input: rounded, top: 0, left: 0 }, { input: borderOverlay, top: 0, left: 0 }])
            .jpeg({ quality: 92 })
            .toBuffer()

        return output
    } catch (e) {
        console.error('[imageBranding] Branding failed:', e.message)
        opts._lastError = e.message   // surfaced to caller for .news logs visibility
        return null
    }
}

module.exports = { brandArticleImage, buildFallbackBackground }
