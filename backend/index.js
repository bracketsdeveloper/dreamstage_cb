'use strict'

const express      = require("express")
const bodyParser   = require("body-parser")
const axios        = require("axios")
const mongoose     = require("mongoose")
const nodemailer   = require("nodemailer")
require("dotenv").config()

const Question = require("./models/Question.js")
const Answer   = require("./models/Answer.js")

const app    = express().use(bodyParser.json())
const PORT   = process.env.PORT       || 3000
const METAURL= "https://graph.facebook.com/v22.0/"
const token  = process.env.TOKEN
const mytoken= process.env.MYTOKEN
const MONGO_URI = process.env.MONGODB_URI

// Email config using Gmail + app password
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER, // your@gmail.com
      pass: process.env.EMAIL_PASS  // your 16-char app password
    }
  });
  

// ─── Global error handlers ─────────────────────────────────────────────────────
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason)
})
process.on('uncaughtException', err => {
  console.error('Uncaught Exception:', err)
  process.exit(1)
})

// ─── Connect to MongoDB ─────────────────────────────────────────────────────────
mongoose
  .connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("MongoDB connected"))
  .catch(err => {
    console.error("MongoDB connection error:", err)
    process.exit(1)
  })

// ─── Verification Endpoint ─────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  try {
    const mode      = req.query["hub.mode"]
    const challenge = req.query["hub.challenge"]
    const tokenReq  = req.query["hub.verify_token"]
    if (mode === "subscribe" && tokenReq === mytoken) {
      return res.status(200).send(challenge)
    }
    return res.sendStatus(403)
  } catch (err) {
    console.error("GET /webhook error:", err)
    return res.sendStatus(500)
  }
})

// ─── Message Handler ─────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body
    // ignore non-WhatsApp callbacks
    if (!body.object) return res.sendStatus(200)

    const entry   = body.entry?.[0]
    const change  = entry?.changes?.[0]?.value
    const msgs    = change?.messages
    if (!Array.isArray(msgs) || msgs.length === 0) return res.sendStatus(200)

    const msg     = msgs[0]
    const type    = msg.type
    const phoneId = change.metadata?.phone_number_id
    const from    = msg.from
    if (!phoneId || !from || (type !== "text" && type !== "interactive")) {
      return res.sendStatus(200)
    }

    // load all questions once
    const allQs = await Question.find().sort({ order: 1 }).exec()
    if (allQs.length === 0) {
      console.error("No questions in database")
      return res.sendStatus(500)
    }

    // fetch or create this user's answer doc
    let userAns = await Answer.findOne({ phoneNumber: from }).exec()
    if (!userAns) {
      userAns = await Answer.create({ phoneNumber: from })
      await askQuestion(phoneId, from, allQs[0])
      return res.sendStatus(200)
    }

    // check if already complete
    const confirmedCount = userAns.responses.filter(r => r.confirmed).length
    if (confirmedCount >= allQs.length) {
      // send final thank you & email one more time
      await sendText(phoneId, from, "You’ve completed all questions. Thank you!")
      await sendCompletionEmail(userAns, allQs)
      return res.sendStatus(200)
    }

    const currentQ = allQs[confirmedCount]

    // ─── Handle options list selection ──────────────────────────────────────────
    if (type === "interactive" && msg.interactive?.list_reply) {
      const selection = msg.interactive.list_reply.title
      userAns.responses.push({ question: currentQ._id, answer: selection, confirmed: false })
      await userAns.save()
      await sendConfirmation(phoneId, from, selection)
      return res.sendStatus(200)
    }

    // ─── Handle Yes/No confirmation buttons ────────────────────────────────────
    if (type === "interactive" && msg.interactive?.button_reply) {
      const replyId   = msg.interactive.button_reply.id
      const pendingIdx = userAns.responses.findIndex(r => !r.confirmed)
      if (pendingIdx < 0) return res.sendStatus(200)

      if (replyId === "yes_response") {
        userAns.responses[pendingIdx].confirmed = true
        await userAns.save()

        const nextIdx = confirmedCount + 1
        if (nextIdx < allQs.length) {
          await askQuestion(phoneId, from, allQs[nextIdx])
        } else {
          // completed!
          await sendText(phoneId, from, "✅ Thank you! You’ve completed all questions.")
          await sendCompletionEmail(userAns, allQs)
        }
      } else if (replyId === "no_response") {
        userAns.responses.splice(pendingIdx, 1)
        await userAns.save()
        await askQuestion(phoneId, from, currentQ)
      }

      return res.sendStatus(200)
    }

    // ─── Handle free-text replies ────────────────────────────────────────────────
    if (type === "text") {
      const textBody = msg.text.body.trim()

      // validate based on answerType
      switch (currentQ.answerType) {
        case "number":
          if (!/^\d+$/.test(textBody)) {
            await sendText(phoneId, from, "⚠️ Please enter a valid number.")
            return askQuestion(phoneId, from, currentQ).then(() => res.sendStatus(200))
          }
          break
        case "boolean":
          if (!/^(yes|no)$/i.test(textBody)) {
            await sendText(phoneId, from, "⚠️ Please reply with Yes or No.")
            return askQuestion(phoneId, from, currentQ).then(() => res.sendStatus(200))
          }
          break
        case "options":
          await sendText(phoneId, from, "⚠️ Please select from the provided list.")
          return askQuestion(phoneId, from, currentQ).then(() => res.sendStatus(200))
      }

      // record response (unconfirmed)
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

// ─── Helpers ────────────────────────────────────────────────────────────────────

async function askQuestion(phoneId, to, questionDoc) {
  if (questionDoc.answerType === "options" && questionDoc.options.length) {
    for (let i = 0; i < questionDoc.options.length; i += 10) {
      const chunk = questionDoc.options.slice(i, i + 10)
      const sections = [{ title: questionDoc.question, rows: chunk.map(opt => ({ id: opt, title: opt })) }]
      try {
        await axios.post(
          `${METAURL}${phoneId}/messages?access_token=${token}`,
          {
            messaging_product: "whatsapp",
            to,
            type: "interactive",
            interactive: {
              type: "list",
              header: { type: "text", text: questionDoc.question },
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
  else if (questionDoc.answerType === "boolean") {
    await sendBooleanButtons(phoneId, to, questionDoc.question)
  }
  else {
    await sendText(phoneId, to, questionDoc.question)
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

async function sendBooleanButtons(phoneId, to, questionText) {
  try {
    await axios.post(
      `${METAURL}${phoneId}/messages?access_token=${token}`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body:    { text: questionText },
          action:  {
            buttons: [
              { type: "reply", reply: { id: "yes_response", title: "Yes" } },
              { type: "reply", reply: { id: "no_response",  title: "No"  } }
            ]
          }
        }
      },
      { headers: { "Content-Type": "application/json" } }
    )
  } catch (e) {
    console.error("sendBooleanButtons error:", e.response?.data || e.message)
  }
}

async function sendConfirmation(phoneId, to, responseText) {
  try {
    await axios.post(
      `${METAURL}${phoneId}/messages?access_token=${token}`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: `You entered: "${responseText}"\nIs this correct?` },
          action: {
            buttons: [
              { type: "reply", reply: { id: "yes_response", title: "Yes" } },
              { type: "reply", reply: { id: "no_response",  title: "No, enter again" } }
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

// ─── Send summary email on completion ───────────────────────────────────────────
async function sendCompletionEmail(userAns, allQs) {
  try {
    const recipients = (process.env.NOTIFY_EMAILS || "")
      .split(",")
      .map(e => e.trim())
      .filter(e => e)

    if (recipients.length === 0) {
      console.warn("No notification emails configured")
      return
    }

    // build email body
    let html = `<h3>New responses from ${userAns.phoneNumber}</h3>`
    if (userAns.userName) {
      html += `<p><strong>Name:</strong> ${userAns.userName}</p>`
    }
    html += `<ul>`
    userAns.responses.forEach(resp => {
      const qObj = allQs.find(q => q._id.equals(resp.question))
      const qText = qObj ? qObj.question : "Unknown question"
      html += `<li><strong>${qText}</strong>: ${resp.answer}</li>`
    })
    html += `</ul>`

    await transporter.sendMail({
      from:    process.env.EMAIL_USER,
      to:      recipients,
      subject: `Questionnaire completed by ${userAns.phoneNumber}`,
      html
    })

    console.log("Completion email sent to:", recipients.join(", "))
  } catch (err) {
    console.error("sendCompletionEmail error:", err)
  }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
