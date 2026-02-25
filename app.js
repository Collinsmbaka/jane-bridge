'use strict'
require('dotenv').config()
const WHATSAPP_VERSION = process.env.WHATSAPP_VERSION || 'v17.0'
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN

const VF_API_KEY = process.env.VF_API_KEY
const VF_VERSION_ID = process.env.VF_VERSION_ID || 'development'
const VF_PROJECT_ID = process.env.VF_PROJECT_ID || null

const fs = require('fs')

const PICOVOICE_API_KEY = process.env.PICOVOICE_API_KEY || null

// Airtable configuration
const AIRTABLE_PAT = process.env.AIRTABLE_PAT
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID
const AIRTABLE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`

// Jane configuration
const JANE_WHATSAPP_NUMBER = process.env.JANE_WHATSAPP_NUMBER
const FREE_MESSAGE_LIMIT = parseInt(process.env.FREE_MESSAGE_LIMIT) || 10
const REFERRAL_BONUS = parseInt(process.env.REFERRAL_BONUS) || 10
const MAX_REFERRALS = parseInt(process.env.MAX_REFERRALS) || 3
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL || 'https://janeforwomen.com'
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || null

// Validate user_id: allow only E.164-like phone numbers (optional +, 8-15 digits)
function isValidUserId(user_id) {
  return typeof user_id === "string" && /^\+?[1-9]\d{7,14}$/.test(user_id);
}

const {
  Leopard,
  LeopardActivationLimitReached,
} = require('@picovoice/leopard-node')

let session = 0
let noreplyTimeout = null
const VF_TRANSCRIPT_ICON =
  'https://s3.amazonaws.com/com.voiceflow.studio/share/200x200/200x200.png'

const VF_DM_URL =
  process.env.VF_DM_URL || 'https://general-runtime.voiceflow.com'

const DMconfig = {
  tts: false,
  stripSSML: true,
}

const express = require('express'),
  body_parser = require('body-parser'),
  axios = require('axios').default,
  app = express().use(body_parser.json())

// ============================================================
// In-Memory User Cache
// ============================================================

const userCache = new Map()

function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let code = 'REF-'
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

function getEffectiveLimit(user) {
  return FREE_MESSAGE_LIMIT + ((user.referrals_earned || 0) * REFERRAL_BONUS)
}

// ============================================================
// Airtable Helpers
// ============================================================

async function airtableLookupUser(phone) {
  try {
    const res = await axios({
      method: 'GET',
      url: `${AIRTABLE_URL}/Users`,
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        'Content-Type': 'application/json',
      },
      params: {
        filterByFormula: `{whatsapp_number}="${phone}"`,
        maxRecords: 1,
      },
    })
    if (res.data.records && res.data.records.length > 0) {
      const rec = res.data.records[0]
      return {
        airtable_id: rec.id,
        message_count: rec.fields.message_count || 0,
        customer_status: rec.fields.customer_status || 'free',
        referral_code: rec.fields.referral_code || null,
        referrals_earned: rec.fields.referrals_earned || 0,
      }
    }
    return null
  } catch (err) {
    console.log('Airtable lookup error:', err.message, err.response?.data)
    return null
  }
}

async function airtableCreateUser(phone, referrerAirtableId) {
  const referralCode = generateReferralCode()
  const fields = {
    whatsapp_number: phone,
    customer_status: 'free',
    message_count: 0,
    referral_code: referralCode,
    referrals_earned: 0,
    source: 'whatsapp',
    created_at: new Date().toISOString(),
  }
  if (referrerAirtableId) {
    fields.referrer_id = [referrerAirtableId]
  }
  try {
    const res = await axios({
      method: 'POST',
      url: `${AIRTABLE_URL}/Users`,
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        'Content-Type': 'application/json',
      },
      data: { fields },
    })
    return {
      airtable_id: res.data.id,
      message_count: 0,
      customer_status: 'free',
      referral_code: referralCode,
      referrals_earned: 0,
    }
  } catch (err) {
    console.log('Airtable create error:', err.message, err.response?.data)
    return null
  }
}

async function airtableUpdateUser(recordId, fields) {
  try {
    await axios({
      method: 'PATCH',
      url: `${AIRTABLE_URL}/Users/${recordId}`,
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        'Content-Type': 'application/json',
      },
      data: { fields },
    })
  } catch (err) {
    console.log('Airtable update error:', err.message, err.response?.data)
  }
}

async function airtableFindByReferralCode(code) {
  try {
    const res = await axios({
      method: 'GET',
      url: `${AIRTABLE_URL}/Users`,
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        'Content-Type': 'application/json',
      },
      params: {
        filterByFormula: `{referral_code}="${code}"`,
        maxRecords: 1,
      },
    })
    if (res.data.records && res.data.records.length > 0) {
      const rec = res.data.records[0]
      return {
        airtable_id: rec.id,
        phone: rec.fields.whatsapp_number,
        message_count: rec.fields.message_count || 0,
        customer_status: rec.fields.customer_status || 'free',
        referral_code: rec.fields.referral_code,
        referrals_earned: rec.fields.referrals_earned || 0,
      }
    }
    return null
  } catch (err) {
    console.log('Airtable referral lookup error:', err.message)
    return null
  }
}

// ============================================================
// Cache Management
// ============================================================

async function getOrCreateUser(phone) {
  // Check cache first
  if (userCache.has(phone)) {
    const cached = userCache.get(phone)
    cached.lastActive = Date.now()
    return cached
  }

  // Fetch from Airtable
  let userData = await airtableLookupUser(phone)

  if (userData) {
    const entry = {
      ...userData,
      lastSynced: Date.now(),
      lastActive: Date.now(),
      dirty: false,
    }
    userCache.set(phone, entry)
    return entry
  }

  // New user — create in Airtable (referral handled separately)
  return null
}

async function createNewUser(phone, referrerAirtableId) {
  const userData = await airtableCreateUser(phone, referrerAirtableId)
  if (userData) {
    const entry = {
      ...userData,
      lastSynced: Date.now(),
      lastActive: Date.now(),
      dirty: false,
    }
    userCache.set(phone, entry)
    return entry
  }
  return null
}

async function syncUserToAirtable(phone) {
  const user = userCache.get(phone)
  if (!user || !user.airtable_id) return
  await airtableUpdateUser(user.airtable_id, {
    message_count: user.message_count,
    last_active: new Date().toISOString(),
  })
  user.lastSynced = Date.now()
  user.dirty = false
}

// Hourly cache cleanup: sync dirty entries, clear stale ones
setInterval(async () => {
  const now = Date.now()
  const ONE_HOUR = 60 * 60 * 1000
  for (const [phone, entry] of userCache) {
    if (now - entry.lastActive > ONE_HOUR) {
      if (entry.dirty) {
        await syncUserToAirtable(phone)
      }
      userCache.delete(phone)
    }
  }
  console.log(`Cache cleanup done. ${userCache.size} entries remain.`)
}, 60 * 60 * 1000)

// Graceful shutdown: sync all dirty cache entries before exit
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Syncing dirty cache entries...')
  for (const [phone, entry] of userCache) {
    if (entry.dirty) {
      await syncUserToAirtable(phone)
    }
  }
  console.log('Cache synced. Exiting.')
  process.exit(0)
})

// ============================================================
// Referral Detection & Processing
// ============================================================

const REFERRAL_CODE_REGEX = /REF-[A-Z0-9]{6}/i

function extractReferralCode(text) {
  const match = text.match(REFERRAL_CODE_REGEX)
  return match ? match[0].toUpperCase() : null
}

function stripReferralCode(text) {
  return text.replace(REFERRAL_CODE_REGEX, '').trim()
}

async function processReferral(referralCode, newUserPhone, phone_number_id) {
  const referrer = await airtableFindByReferralCode(referralCode)
  if (!referrer) return null
  if (referrer.referrals_earned >= MAX_REFERRALS) return null

  // Update referrer in Airtable: +REFERRAL_BONUS messages, +1 referrals_earned
  const newCount = referrer.message_count + REFERRAL_BONUS
  const newReferralsEarned = referrer.referrals_earned + 1
  await airtableUpdateUser(referrer.airtable_id, {
    message_count: newCount,
    referrals_earned: newReferralsEarned,
  })

  // Update referrer in cache if present
  if (userCache.has(referrer.phone)) {
    const cached = userCache.get(referrer.phone)
    cached.message_count = newCount
    cached.referrals_earned = newReferralsEarned
    cached.dirty = false // just synced
  }

  // Notify referrer via WhatsApp
  try {
    await sendWhatsAppText(
      phone_number_id,
      referrer.phone,
      `Great news! Your friend just joined Jane 🎉\nYou've both been gifted ${REFERRAL_BONUS} extra messages. Enjoy!`
    )
  } catch (err) {
    console.log('Failed to notify referrer:', err.message)
  }

  // Fire Make.com webhook if configured
  if (MAKE_WEBHOOK_URL) {
    try {
      await axios.post(MAKE_WEBHOOK_URL, {
        event: 'referral_completed',
        referrer_phone: referrer.phone,
        referee_phone: newUserPhone,
        referral_code: referralCode,
      })
    } catch (err) {
      console.log('Make.com webhook error:', err.message)
    }
  }

  return referrer.airtable_id
}

// ============================================================
// Soft Block: Message Limit & Keyword Handling
// ============================================================

function isUserBlocked(user) {
  if (!user) return false
  if (user.customer_status === 'paying') return false
  return user.message_count >= getEffectiveLimit(user)
}

function buildReferralLink(referralCode) {
  return `https://wa.me/${JANE_WHATSAPP_NUMBER}?text=Hi%20Jane%20${referralCode}`
}

function buildLimitMessage(user) {
  const hasReferralsLeft = (user.referrals_earned || 0) < MAX_REFERRALS
  let msg = `You've used all your free messages with Jane!\n\nBut don't worry, here are ways to keep chatting:\n\n`
  if (hasReferralsLeft) {
    msg += `1️⃣ *Share with a friend* — You'll BOTH get ${REFERRAL_BONUS} more free messages!\nYour link: ${buildReferralLink(user.referral_code)}\n\n`
    msg += `2️⃣ *Get a wellness product* — Unlock unlimited messages!\nVisit: ${SHOPIFY_STORE_URL}`
  } else {
    msg += `*Get a wellness product* — Unlock unlimited messages!\nVisit: ${SHOPIFY_STORE_URL}`
  }
  return msg
}

function buildHelpMessage(user) {
  const hasReferralsLeft = (user.referrals_earned || 0) < MAX_REFERRALS
  let msg = `You've reached your free message limit.\n\nHere's how to unlock more:\n\n`
  if (hasReferralsLeft) {
    msg += `- *Refer a friend*: Type "referral" to get your personal link. You'll both get ${REFERRAL_BONUS} free messages!\n`
  }
  msg += `- *Purchase a product*: Buying any wellness product unlocks unlimited messages. Type "buy" for the link.`
  return msg
}

function buildBuyMessage() {
  return `Purchasing any wellness product unlocks *unlimited messages* with Jane!\n\nBrowse our products here: ${SHOPIFY_STORE_URL}\n\nYou can also refer friends for free messages — type "referral" to get your link.`
}

function buildReferralMessage(user) {
  const hasReferralsLeft = (user.referrals_earned || 0) < MAX_REFERRALS
  if (hasReferralsLeft) {
    return `Share this link with a friend — you'll BOTH get ${REFERRAL_BONUS} free messages!\n\nYour link: ${buildReferralLink(user.referral_code)}`
  }
  return `You've used all ${MAX_REFERRALS} referral slots. To keep chatting with Jane, get a wellness product:\n${SHOPIFY_STORE_URL}`
}

async function handleSoftBlock(user, messageText, phone_number_id, from) {
  const lower = (messageText || '').toLowerCase().trim()

  let responseText
  if (lower === 'referral') {
    responseText = buildReferralMessage(user)
  } else if (lower === 'help') {
    responseText = buildHelpMessage(user)
  } else if (lower === 'buy' || lower === 'purchase') {
    responseText = buildBuyMessage()
  } else {
    responseText = buildLimitMessage(user)
  }

  await sendWhatsAppText(phone_number_id, from, responseText)
}

// ============================================================
// WhatsApp Direct Send Helper
// ============================================================

async function sendWhatsAppText(phone_number_id, to, text) {
  await axios({
    method: 'POST',
    url: `https://graph.facebook.com/${WHATSAPP_VERSION}/${phone_number_id}/messages`,
    data: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'text',
      text: {
        preview_url: true,
        body: text,
      },
    },
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + WHATSAPP_TOKEN,
    },
  })
}

// ============================================================
// Main Message Processing (pre-Voiceflow)
// ============================================================

async function processIncomingMessage(user_id, messageText, phone_number_id, user_name, requestBuilder) {
  // Step 1: Get or create user
  let user = await getOrCreateUser(user_id)
  let isNewUser = false
  let cleanedText = messageText

  if (!user) {
    isNewUser = true

    // Step 2: Check for referral code (new users only)
    let referrerAirtableId = null
    if (messageText) {
      const refCode = extractReferralCode(messageText)
      if (refCode) {
        referrerAirtableId = await processReferral(refCode, user_id, phone_number_id)
        cleanedText = stripReferralCode(messageText)
        if (!cleanedText) cleanedText = 'Hi'
      }
    }

    // Create user in Airtable
    user = await createNewUser(user_id, referrerAirtableId)
    if (!user) {
      // Airtable down — forward to Voiceflow without tracking
      console.log('Airtable unavailable, forwarding without tracking')
      const request = requestBuilder(messageText)
      await interact(user_id, request, phone_number_id, user_name, null)
      return
    }
  }

  // Step 3: Check if blocked (free users only)
  if (isUserBlocked(user)) {
    await handleSoftBlock(user, messageText, phone_number_id, user_id)
    return
  }

  // Step 4: Increment message count (free users only)
  if (user.customer_status !== 'paying') {
    user.message_count += 1
    user.dirty = true
    user.lastActive = Date.now()

    // Step 5: Sync every 5 messages
    if (user.message_count % 5 === 0) {
      syncUserToAirtable(user_id).catch(err =>
        console.log('Background sync error:', err.message)
      )
    }
  }

  // Step 6: Forward to Voiceflow
  const request = requestBuilder(isNewUser ? cleanedText : messageText)
  await interact(user_id, request, phone_number_id, user_name, user)
}

// ============================================================
// Express Server
// ============================================================

app.listen(process.env.PORT || 3000, () => console.log('webhook is listening'))

app.get('/', (req, res) => {
  res.json({
    success: true,
    info: 'Jane Bridge v2.0.0 | WhatsApp ↔ Voiceflow',
    status: 'healthy',
    cache_size: userCache.size,
    error: null,
  })
})

// Accepts POST requests at /webhook endpoint
app.post('/webhook', async (req, res) => {
  if (req.body.object) {
    const isNotInteractive =
      req.body?.entry[0]?.changes[0]?.value?.messages?.length || null
    if (isNotInteractive) {
      let phone_number_id =
        req.body.entry[0].changes[0].value.metadata.phone_number_id
      let user_id = req.body.entry[0].changes[0].value.messages[0].from
      // Validate user_id before using it to prevent SSRF
      if (!isValidUserId(user_id)) {
        res.status(400).json({ message: 'Invalid user ID format.' });
        return;
      }
      let user_name =
        req.body.entry[0].changes[0].value.contacts[0].profile.name

      if (req.body.entry[0].changes[0].value.messages[0].text) {
        const messageText = req.body.entry[0].changes[0].value.messages[0].text.body
        await processIncomingMessage(
          user_id,
          messageText,
          phone_number_id,
          user_name,
          (text) => ({ type: 'text', payload: text })
        )
      } else if (req.body?.entry[0]?.changes[0]?.value?.messages[0]?.audio) {
        if (
          req.body?.entry[0]?.changes[0]?.value?.messages[0]?.audio?.voice ==
            true &&
          PICOVOICE_API_KEY
        ) {
          let mediaURL = await axios({
            method: 'GET',
            url: `https://graph.facebook.com/${WHATSAPP_VERSION}/${req.body.entry[0].changes[0].value.messages[0].audio.id}`,
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + WHATSAPP_TOKEN,
            },
          })

          const rndFileName =
            'audio_' + Math.random().toString(36).substring(7) + '.ogg'

          axios({
            method: 'get',
            url: mediaURL.data.url,
            headers: {
              Authorization: 'Bearer ' + WHATSAPP_TOKEN,
            },
            responseType: 'stream',
          }).then(function (response) {
            let engineInstance = new Leopard(PICOVOICE_API_KEY)
            const wstream = fs.createWriteStream(rndFileName)
            response.data.pipe(wstream)
            wstream.on('finish', async () => {
              console.log('Analysing Audio file')
              const { transcript, words } =
                engineInstance.processFile(rndFileName)
              engineInstance.release()
              fs.unlinkSync(rndFileName)
              if (transcript && transcript != '') {
                console.log('User audio:', transcript)
                await processIncomingMessage(
                  user_id,
                  transcript,
                  phone_number_id,
                  user_name,
                  (text) => ({ type: 'text', payload: text })
                )
              }
            })
          })
        }
      } else {
        // Interactive button replies
        const interactiveMsg = req.body.entry[0].changes[0].value.messages[0].interactive
        const buttonId = interactiveMsg.button_reply.id
        const buttonTitle = interactiveMsg.button_reply.title

        if (buttonId.includes('path-')) {
          await processIncomingMessage(
            user_id,
            buttonTitle,
            phone_number_id,
            user_name,
            () => ({
              type: buttonId,
              payload: { label: buttonTitle },
            })
          )
        } else {
          await processIncomingMessage(
            user_id,
            buttonTitle,
            phone_number_id,
            user_name,
            () => ({
              type: 'intent',
              payload: {
                query: buttonTitle,
                intent: { name: buttonId },
                entities: [],
              },
            })
          )
        }
      }
    }
    res.status(200).json({ message: 'ok' })
  } else {
    res.status(400).json({ message: 'error | unexpected body' })
  }
})

// Webhook verification — fixed: removed || 'voiceflow' bug
app.get('/webhook', (req, res) => {
  let mode = req.query['hub.mode']
  let token = req.query['hub.verify_token']
  let challenge = req.query['hub.challenge']

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED')
      res.status(200).send(challenge)
    } else {
      res.sendStatus(403)
    }
  } else {
    res.sendStatus(400)
  }
})

// ============================================================
// Voiceflow Interaction
// ============================================================

async function interact(user_id, request, phone_number_id, user_name, cachedUser) {
  clearTimeout(noreplyTimeout)
  if (!session) {
    session = `${VF_VERSION_ID}.${rndID()}`
  }

  // Patch session variables including user metadata from cache
  const variables = {
    user_id: cachedUser ? cachedUser.airtable_id : user_id,
    user_name: user_name,
  }
  if (cachedUser) {
    variables.customer_status = cachedUser.customer_status
    variables.message_count = cachedUser.message_count
    variables.referral_code = cachedUser.referral_code
  }

  await axios({
    method: 'PATCH',
    url: `${VF_DM_URL}/state/user/${encodeURI(user_id)}/variables`,
    headers: {
      Authorization: VF_API_KEY,
      'Content-Type': 'application/json',
    },
    data: variables,
  })

  let response = await axios({
    method: 'POST',
    url: `${VF_DM_URL}/state/user/${encodeURI(user_id)}/interact`,
    headers: {
      Authorization: VF_API_KEY,
      'Content-Type': 'application/json',
      versionID: VF_VERSION_ID,
      sessionID: session,
    },
    data: {
      action: request,
      config: DMconfig,
    },
  })

  let isEnding = response.data.filter(({ type }) => type === 'end')
  if (isEnding.length > 0) {
    console.log('isEnding')
    isEnding = true
    saveTranscript(user_name)
  } else {
    isEnding = false
  }

  let messages = []

  for (let i = 0; i < response.data.length; i++) {
    if (response.data[i].type == 'text') {
      let tmpspeech = ''

      for (let j = 0; j < response.data[i].payload.slate.content.length; j++) {
        for (
          let k = 0;
          k < response.data[i].payload.slate.content[j].children.length;
          k++
        ) {
          if (response.data[i].payload.slate.content[j].children[k].type) {
            if (
              response.data[i].payload.slate.content[j].children[k].type ==
              'link'
            ) {
              tmpspeech +=
                response.data[i].payload.slate.content[j].children[k].url
            }
          } else if (
            response.data[i].payload.slate.content[j].children[k].text != '' &&
            response.data[i].payload.slate.content[j].children[k].fontWeight
          ) {
            tmpspeech +=
              '*' +
              response.data[i].payload.slate.content[j].children[k].text +
              '*'
          } else if (
            response.data[i].payload.slate.content[j].children[k].text != '' &&
            response.data[i].payload.slate.content[j].children[k].italic
          ) {
            tmpspeech +=
              '_' +
              response.data[i].payload.slate.content[j].children[k].text +
              '_'
          } else if (
            response.data[i].payload.slate.content[j].children[k].text != '' &&
            response.data[i].payload.slate.content[j].children[k].underline
          ) {
            tmpspeech +=
              response.data[i].payload.slate.content[j].children[k].text
          } else if (
            response.data[i].payload.slate.content[j].children[k].text != '' &&
            response.data[i].payload.slate.content[j].children[k].strikeThrough
          ) {
            tmpspeech +=
              '~' +
              response.data[i].payload.slate.content[j].children[k].text +
              '~'
          } else if (
            response.data[i].payload.slate.content[j].children[k].text != ''
          ) {
            tmpspeech +=
              response.data[i].payload.slate.content[j].children[k].text
          }
        }
        tmpspeech += '\n'
      }
      if (
        response.data[i + 1]?.type &&
        response.data[i + 1]?.type == 'choice'
      ) {
        messages.push({
          type: 'body',
          value: tmpspeech,
        })
      } else {
        messages.push({
          type: 'text',
          value: tmpspeech,
        })
      }
    } else if (response.data[i].type == 'speak') {
      if (response.data[i].payload.type == 'audio') {
        messages.push({
          type: 'audio',
          value: response.data[i].payload.src,
        })
      } else {
        if (
          response.data[i + 1]?.type &&
          response.data[i + 1]?.type == 'choice'
        ) {
          messages.push({
            type: 'body',
            value: response.data[i].payload.message,
          })
        } else {
          messages.push({
            type: 'text',
            value: response.data[i].payload.message,
          })
        }
      }
    } else if (response.data[i].type == 'visual') {
      messages.push({
        type: 'image',
        value: response.data[i].payload.image,
      })
    } else if (response.data[i].type == 'choice') {
      let buttons = []
      for (let b = 0; b < response.data[i].payload.buttons.length; b++) {
        let link = null
        if (
          response.data[i].payload.buttons[b].request.payload.actions !=
            undefined &&
          response.data[i].payload.buttons[b].request.payload.actions.length > 0
        ) {
          link =
            response.data[i].payload.buttons[b].request.payload.actions[0]
              .payload.url
        }
        if (link) {
          // Ignore links
        } else if (
          response.data[i].payload.buttons[b].request.type.includes('path-')
        ) {
          let id = response.data[i].payload.buttons[b].request.payload.label
          buttons.push({
            type: 'reply',
            reply: {
              id: response.data[i].payload.buttons[b].request.type,
              title:
                truncateString(
                  response.data[i].payload.buttons[b].request.payload.label
                ) ?? '',
            },
          })
        } else {
          buttons.push({
            type: 'reply',
            reply: {
              id: response.data[i].payload.buttons[b].request.payload.intent
                .name,
              title:
                truncateString(
                  response.data[i].payload.buttons[b].request.payload.label
                ) ?? '',
            },
          })
        }
      }
      if (buttons.length > 3) {
        buttons = buttons.slice(0, 3)
      }
      messages.push({
        type: 'buttons',
        buttons: buttons,
      })
    } else if (response.data[i].type == 'no-reply' && isEnding == false) {
      noreplyTimeout = setTimeout(function () {
        sendNoReply(user_id, request, phone_number_id, user_name)
      }, Number(response.data[i].payload.timeout) * 1000)
    }
  }
  await sendMessage(messages, phone_number_id, user_id)
  if (isEnding == true) {
    session = null
  }
}

// ============================================================
// WhatsApp Message Sender (multi-type)
// ============================================================

async function sendMessage(messages, phone_number_id, from) {
  const timeoutPerKB = 10
  for (let j = 0; j < messages.length; j++) {
    let data
    let ignore = null
    if (messages[j].type == 'image') {
      data = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: from,
        type: 'image',
        image: {
          link: messages[j].value,
        },
      }
    } else if (messages[j].type == 'audio') {
      data = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: from,
        type: 'audio',
        audio: {
          link: messages[j].value,
        },
      }
    } else if (messages[j].type == 'buttons') {
      data = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: from,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: {
            text: messages[j - 1]?.value || 'Make your choice',
          },
          action: {
            buttons: messages[j].buttons,
          },
        },
      }
    } else if (messages[j].type == 'text') {
      data = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: from,
        type: 'text',
        text: {
          preview_url: true,
          body: messages[j].value,
        },
      }
    } else {
      ignore = true
    }
    if (!ignore) {
      try {
        await axios({
          method: 'POST',
          url: `https://graph.facebook.com/${WHATSAPP_VERSION}/${phone_number_id}/messages`,
          data: data,
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + WHATSAPP_TOKEN,
          },
        })

        if (messages[j].type === 'image') {
          try {
            const response = await axios.head(messages[j].value)

            if (response.headers['content-length']) {
              const imageSizeKB =
                parseInt(response.headers['content-length']) / 1024
              const timeout = imageSizeKB * timeoutPerKB
              await new Promise((resolve) => setTimeout(resolve, timeout))
            }
          } catch (error) {
            console.error('Failed to fetch image size:', error)
            await new Promise((resolve) => setTimeout(resolve, 5000))
          }
        }
      } catch (err) {
        console.log(err)
      }
    }
  }
}

// ============================================================
// Utility Functions
// ============================================================

async function sendNoReply(user_id, request, phone_number_id, user_name) {
  clearTimeout(noreplyTimeout)
  console.log('No reply')
  await interact(
    user_id,
    {
      type: 'no-reply',
    },
    phone_number_id,
    user_name,
    userCache.get(user_id) || null
  )
}

var rndID = function () {
  var randomNo = Math.floor(Math.random() * 1000 + 1)
  var timestamp = Date.now()
  var date = new Date()
  var weekday = new Array(7)
  weekday[0] = 'Sunday'
  weekday[1] = 'Monday'
  weekday[2] = 'Tuesday'
  weekday[3] = 'Wednesday'
  weekday[4] = 'Thursday'
  weekday[5] = 'Friday'
  weekday[6] = 'Saturday'
  var day = weekday[date.getDay()]
  return randomNo + day + timestamp
}

function truncateString(str, maxLength = 20) {
  if (str) {
    if (str.length > maxLength) {
      return str.substring(0, maxLength - 1) + '…'
    }
    return str
  }
  return ''
}

async function saveTranscript(username) {
  if (VF_PROJECT_ID) {
    if (!username || username == '' || username == undefined) {
      username = 'Anonymous'
    }
    axios({
      method: 'put',
      url: 'https://api.voiceflow.com/v2/transcripts',
      data: {
        browser: 'WhatsApp',
        device: 'desktop',
        os: 'server',
        sessionID: session,
        unread: true,
        versionID: VF_VERSION_ID,
        projectID: VF_PROJECT_ID,
        user: {
          name: username,
          image: VF_TRANSCRIPT_ICON,
        },
      },
      headers: {
        Authorization: process.env.VF_API_KEY,
      },
    })
      .then(function (response) {
        console.log('Transcript Saved!')
      })
      .catch((err) => console.log(err))
  }
  session = `${VF_VERSION_ID}.${rndID()}`
}
