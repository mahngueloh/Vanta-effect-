'use strict'

const axios = require('axios')
const FormData = require('form-data')
const config = require('../config')

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000     // doubles each retry (2s, 4s, 8s)
const TIMEOUT_MS = 20_000

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function token()  { return config.news.telegramBotToken || '' }
function chatId()  { return config.news.telegramChannelId || '' }
function masterEnabled() { return Boolean(config.news.telegramEnabled) }

function isTelegramConfigured() {
    return Boolean(masterEnabled() && token() && chatId())
}

function getTelegramStatus() {
    return {
        masterEnabled: masterEnabled(),
        tokenSet: Boolean(token()),
        chatId: chatId() ? String(chatId()) : '(not set)',
        configured: isTelegramConfigured(),
    }
}

async function requestWithRetry(fn) {
    let lastError = null
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fn()
            return { success: true, attempts: attempt, raw: res.data }
        } catch (e) {
            const description = e.response?.data?.description || e.message
            const status = e.response?.status
            lastError = description
            const isPermanent = status === 401 || status === 403
                || /chat not found|bot was blocked|not enough rights/i.test(description || '')
            if (isPermanent) break
            if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * Math.pow(2, attempt - 1))
        }
    }
    return { success: false, error: lastError || 'Unknown Telegram error', attempts: MAX_RETRIES }
}

async function publishToTelegram(text, imageBuffer = null, imageUrl = null) {
    if (!masterEnabled()) return { skipped: true, error: 'Telegram is disabled in .env (TELEGRAM_ENABLED=false)' }
    if (!token() || !chatId()) return { skipped: true, error: 'Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID in .env' }

    if (imageBuffer) {
        return requestWithRetry(() => {
            const form = new FormData()
            form.append('chat_id', chatId())
            form.append('caption', text)
            form.append('parse_mode', 'Markdown')
            form.append('photo', imageBuffer, { filename: 'photo.jpg', contentType: 'image/jpeg' })
            return axios.post(`https://api.telegram.org/bot${token()}/sendPhoto`, form, {
                headers: form.getHeaders(), timeout: TIMEOUT_MS, maxContentLength: Infinity, maxBodyLength: Infinity,
            })
        })
    }

    if (imageUrl) {
        return requestWithRetry(() => axios.post(`https://api.telegram.org/bot${token()}/sendPhoto`, {
            chat_id: chatId(), photo: imageUrl, caption: text, parse_mode: 'Markdown',
        }, { timeout: TIMEOUT_MS }))
    }

    return requestWithRetry(() => axios.post(`https://api.telegram.org/bot${token()}/sendMessage`, {
        chat_id: chatId(), text, parse_mode: 'Markdown', disable_web_page_preview: false,
    }, { timeout: TIMEOUT_MS }))
}

async function testTelegram() {
    if (!masterEnabled()) return { success: false, error: 'TELEGRAM_ENABLED=false in .env — set it to "true" first' }
    if (!token() || !chatId()) return { success: false, error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID missing in .env' }
    const result = await publishToTelegram(`✅ Test message from *${config.botName}* — Telegram is connected correctly.`)
    return result
}

module.exports = {
    isTelegramConfigured,
    getTelegramStatus,
    publishToTelegram,
    testTelegram,
}
