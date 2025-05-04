'use strict'

const express    = require("express")
const bodyParser = require("body-parser")
const axios      = require("axios")
const mongoose   = require("mongoose")
const nodemailer = require("nodemailer")
require("dotenv").config()

const Question = require("./models/Question.js")
const Answer   = require("./models/Answer.js")

const app     = express().use(bodyParser.json())
const PORT    = process.env.PORT       || 3000
const METAURL = "https://graph.facebook.com/v22.0/"
const token   = process.env.TOKEN
const mytoken = process.env.MYTOKEN
const MONGO_URI = process.env.MONGODB_URI

// Gmail transporter with app password
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
})

// global error handlers
process.on('unhandledRejection', (reason, p) => console.error('Unhandled Rejection at:', p, 'reason:', reason))
process.on('uncaughtException', err => { console.error('Uncaught Exception:', err); process.exit(1) })

// connect to MongoDB
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("MongoDB connected"))
  .catch(err => { console.error("MongoDB connection error:", err); process.exit(1) })

// webhook verification
app.get("/webhook", (req, res) => {
  try {
    const { "hub.mode": mode, "hub.challenge": challenge, "hub.verify_token": tokenReq } = req.query
    if (mode === "subscribe" && tokenReq === mytoken) {
      return res.status(200).send(challenge)
    }
    return res.sendStatus(403)
  } catch (err) {
    console.error("GET /webhook error:", err)
    return res.sendStatus(500)
  }
})

// message handler
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body
    if (!body.object) return res.sendStatus(200)

    const entry  = body.entry?.[0]
    const change = entry?.changes?.[0]?.value
    const msgs   = change?.messages
    if (!Array.isArray(msgs) || !msgs.length) return res.sendStatus(200)

    const msg     = msgs[0]
    const type    = msg.type
    const phoneId = change.metadata?.phone_number_id
    const from    = msg.from
    if (!phoneId || !from || (type !== "text" && type !== "interactive")) {
      return res.sendStatus(200)
    }

    const allQs = await Question.find().sort({ order: 1 }).exec()
    if (!allQs.length) {
      console.error("No questions in DB")
      return res.sendStatus(500)
    }

    let userAns = await Answer.findOne({ phoneNumber: from }).exec()
    if (!userAns) {
      userAns = await Answer.create({ phoneNumber: from })
      await askQuestion(phoneId, from, allQs[0])
      return res.sendStatus(200)
    }

    const confirmedCount = userAns.responses.filter(r => r.confirmed).length
    if (confirmedCount >= allQs.length) {
      await sendText(phoneId, from, "You’ve completed all questions. Thank you!")
      await sendCompletionEmail(userAns, allQs)
      return res.sendStatus(200)
    }
    const currentQ = allQs[confirmedCount]

    // initial list selection
    if (type === "interactive" && msg.interactive?.list_reply) {
      const sel = msg.interactive.list_reply.title
      userAns.responses.push({ question: currentQ._id, answer: sel, confirmed: false })
      await userAns.save()
      await sendConfirmation(phoneId, from, sel)
      return res.sendStatus(200)
    }

    // initial boolean answer
    if (type === "interactive" && msg.interactive?.button_reply?.id?.startsWith("ans_")) {
      const ansId = msg.interactive.button_reply.id
      const ans   = ansId === "ans_yes" ? "Yes" : "No"
      userAns.responses.push({ question: currentQ._id, answer: ans, confirmed: false })
      await userAns.save()
      await sendConfirmation(phoneId, from, ans)
      return res.sendStatus(200)
    }

    // confirmation buttons
    if (type === "interactive" && msg.interactive?.button_reply?.id?.startsWith("confirm_")) {
      const btnId = msg.interactive.button_reply.id
      const idx   = userAns.responses.findIndex(r => !r.confirmed)
      if (idx < 0) return res.sendStatus(200)

      if (btnId === "confirm_yes") {
        userAns.responses[idx].confirmed = true
        await userAns.save()
        const nextIdx = confirmedCount + 1
        if (nextIdx < allQs.length) {
          await askQuestion(phoneId, from, allQs[nextIdx])
        } else {
          await sendText(phoneId, from, "✅ All done!")
          await sendCompletionEmail(userAns, allQs)
        }
      } else if (btnId === "confirm_no") {
        userAns.responses.splice(idx, 1)
        await userAns.save()
        await askQuestion(phoneId, from, currentQ)
      }
      return res.sendStatus(200)
    }

    // free-text replies
    if (type === "text") {
      const textBody = msg.text.body.trim()
      switch (currentQ.answerType) {
        case "number":
          if (!/^\d+$/.test(textBody)) {
            await sendText(phoneId, from, "⚠️ Please enter a valid number.")
            await askQuestion(phoneId, from, currentQ)
            return res.sendStatus(200)
          }
          break
        case "boolean":
          await sendText(phoneId, from, "⚠️ Please use the Yes/No buttons.")
          await askQuestion(phoneId, from, currentQ)
          return res.sendStatus(200)
        case "options":
          await sendText(phoneId, from, "⚠️ Please select from the list.")
          await askQuestion(phoneId, from, currentQ)
          return res.sendStatus(200)
      }
      userAns.responses = userAns.responses.filter(r => r.confirmed)
      userAns.responses.push({ question: currentQ._id, answer: textBody, confirmed: false })
      await userAns.save()
      await sendConfirmation(phoneId, from, textBody)
      return res.sendStatus(200)
    }

    return res.sendStatus(200)
  } catch (err) {
    console.error("POST /webhook error:", err)
    return res.sendStatus(500)
  }
})

async function askQuestion(phoneId, to, q) {
  if (q.answerType === "options" && q.options.length) {
    for (let i = 0; i < q.options.length; i += 10) {
      const chunk = q.options.slice(i, i + 10)
      const sections = [{
        title: q.question,
        rows: chunk.map(o => ({ id: o, title: o }))
      }]
      try {
        await axios.post(
          `${METAURL}${phoneId}/messages?access_token=${token}`,
          {
            messaging_product: "whatsapp",
            to,
            type: "interactive",
            interactive: {
              type: "list",
              header: { type: "text", text: q.question },
              body:   { text: "Please choose an option." },
              action: { button: "View options", sections }
            }
          },
          { headers: { "Content-Type": "application/json" } }
        )
      } catch (e) {
        console.error("askQuestion(list) error:", e.response?.data || e.message)
      }
    }
  }
  else if (q.answerType === "boolean") {
    await axios.post(
      `${METAURL}${phoneId}/messages?access_token=${token}`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body:   { text: q.question },
          action: {
            buttons: [
              { type: "reply", reply: { id: "ans_yes", title: "Yes" }},
              { type: "reply", reply: { id: "ans_no",  title: "No"  }}
            ]
          }
        }
      },
      { headers: { "Content-Type": "application/json" } }
    )
  }
  else {
    await sendText(phoneId, to, q.question)
  }
}

async function sendText(phoneId, to, body) {
  try {
    await axios.post(
      `${METAURL}${phoneId}/messages?access_token=${token}`,
      { messaging_product: "whatsapp", to, text: { body } },
      { headers: { "Content-Type": "application/json" } }
    )
  } catch (e) {
    console.error("sendText error:", e.response?.data || e.message)
  }
}

async function sendConfirmation(phoneId, to, resp) {
  try {
    await axios.post(
      `${METAURL}${phoneId}/messages?access_token=${token}`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body:   { text: `You selected: "${resp}"\nDo you want to change it?` },
          action: {
            buttons: [
              { type: "reply", reply: { id: "confirm_yes", title: "Yes, continue" } },
              { type: "reply", reply: { id: "confirm_no",  title: "No, change it" } }
            ]
          }
        }
      },
      { headers: { "Content-Type": "application/json" } }
    )
  } catch (e) {
    console.error("sendConfirmation error:", e.response?.data || e.message)
  }
}

async function sendCompletionEmail(userAns, allQs) {
  try {
    const recipients = (process.env.NOTIFY_EMAILS || "").split(",").map(e => e.trim()).filter(Boolean)
    if (!recipients.length) return

    let html = `<h3>Responses from ${userAns.phoneNumber}</h3><ul>`
    userAns.responses.forEach(r => {
      const q = allQs.find(q => q._id.equals(r.question))
      html += `<li><strong>${q?.question||"?"}</strong>: ${r.answer}</li>`
    })
    html += `</ul>`

    await transporter.sendMail({
      from:    process.env.EMAIL_USER,
      to:      recipients,
      subject: `Questionnaire completed by ${userAns.phoneNumber}`,
      html
    })
    console.log("Email sent to:", recipients.join(", "))
  } catch (err) {
    console.error("sendCompletionEmail error:", err)
  }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
