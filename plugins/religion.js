const fmt = require('../lib/format')

async function getBible(verse) {
    try {
        const query = (verse || 'John 3:16').trim()
        const res   = await fetch(
            `https://bible-api.com/${encodeURIComponent(query)}`,
            { signal: AbortSignal.timeout(10000) }
        )
        const data = await res.json()
        if (data.error) {
            return fmt.box('BIBLE', [
                `❌ Verse not found: *${query}*`,
                ``,
                `💡 Examples:`,
                `• *.bible John 3:16*`,
                `• *.bible Psalms 23:1*`,
                `• *.bible Genesis 1:1*`,
            ])
        }
        return fmt.box('HOLY BIBLE', [
            `📖 *${data.reference}*`,
            ``,
            `_${data.text.trim()}_`,
            ``,
            `_— Bible (WEB Translation)_`,
        ])
    } catch {
        return fmt.box('ERROR', [`❌ Could not fetch Bible verse. Try again.`])
    }
}

async function getQuran(input) {
    try {
        const num = parseInt(input) || 1
        if (num < 1 || num > 6236) {
            return fmt.box('QURAN', [
                `❌ Invalid ayah number`,
                ``,
                `Enter a number between *1* and *6236*`,
                `Example: *.quran 255* (Ayat Al-Kursi)`,
            ])
        }

        const [res, res2] = await Promise.all([
            fetch(`https://api.alquran.cloud/v1/ayah/${num}/en.asad`, { signal: AbortSignal.timeout(10000) }),
            fetch(`https://api.alquran.cloud/v1/ayah/${num}/ar.alafasy`, { signal: AbortSignal.timeout(10000) }),
        ])
        const data  = await res.json()
        const data2 = await res2.json()

        if (data.code !== 200) return fmt.box('QURAN', [`❌ Ayah not found.`])
        const a = data.data
        return fmt.box('HOLY QURAN', [
            `🕌 *Surah ${a.surah.englishName} (${a.surah.name})*`,
            `📍 Ayah *${a.numberInSurah}* of *${a.surah.numberOfAyahs}*`,
            ``,
            data2.code === 200 ? `*Arabic:*\n${data2.data.text}` : null,
            ``,
            `*Translation (Asad):*`,
            `_${a.text}_`,
        ].filter(v => v !== null))
    } catch {
        return fmt.box('ERROR', [`❌ Could not fetch Quran ayah. Try again.`])
    }
}

module.exports = { getBible, getQuran }
