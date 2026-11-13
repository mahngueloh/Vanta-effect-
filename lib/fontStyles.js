'use strict'

// Every style below comes from a contiguous Unicode block (no reserved gaps),
// so every A-Z/a-z/0-9 maps to a real character — never a broken glyph.
const STYLES = {
    1: { name: 'Bold',      upper: 0x1D400, lower: 0x1D41A, digit: 0x1D7CE },
    2: { name: 'Fullwidth', upper: 0xFF21,  lower: 0xFF41,  digit: 0xFF10 },
    3: { name: 'Monospace', upper: 0x1D670, lower: 0x1D68A, digit: 0x1D7F6 },
}

function applyStyle(text, styleNum) {
    const s = STYLES[styleNum]
    if (!s) return text
    return [...text].map(ch => {
        const code = ch.codePointAt(0)
        if (code >= 65 && code <= 90)  return String.fromCodePoint(s.upper + (code - 65))   // A-Z
        if (code >= 97 && code <= 122) return String.fromCodePoint(s.lower + (code - 97))   // a-z
        if (code >= 48 && code <= 57)  return String.fromCodePoint(s.digit + (code - 48))   // 0-9
        return ch
    }).join('')
}

function styleList() {
    return Object.entries(STYLES).map(([n, s]) => `${n}. ${s.name} — ${applyStyle('Sample123', Number(n))}`).join('\n')
}

module.exports = { applyStyle, styleList, STYLES }
