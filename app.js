const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const nodemailer = require('nodemailer');
require('dotenv').config();

// הגדרת אפליקציה
const app = express();
const port = process.env.PORT || 3000;

// חיבור למסד נתונים SQLite עם error handling
const db = new sqlite3.Database('./messages.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
    process.exit(1);
  }
  console.log('Connected to SQLite database');
});

// יצירת טבלאות משופרות
db.serialize(() => {
  // טבלת הודעות
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE,
      phone_number TEXT,
      contact_name TEXT,
      message TEXT,
      message_type TEXT,
      status TEXT DEFAULT 'pending',
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      responded_at DATETIME NULL,
      alert_sent BOOLEAN DEFAULT 0,
      last_alert_at DATETIME NULL
    )
  `);

  // טבלת שיחות (לקיבוץ הודעות לפי איש קשר)
  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT UNIQUE,
      contact_name TEXT,
      last_message_at DATETIME,
      status TEXT DEFAULT 'active',
      total_messages INTEGER DEFAULT 0,
      unanswered_count INTEGER DEFAULT 0
    )
  `);
});

// הגדרת Email
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Middleware
app.use(bodyParser.json());
app.use(express.static('public')); // לממשק ניהול

// פונקציה לשליחת התראות
async function sendAlert(messages) {
  if (!process.env.ALERT_EMAIL) {
    console.log('No alert email configured');
    return;
  }

  const messageList = messages.map(msg => 
    `📱 ${msg.contact_name || msg.phone_number}\n` +
    `⏰ ${new Date(msg.received_at).toLocaleString('he-IL')}\n` +
    `💬 ${msg.message.substring(0, 100)}${msg.message.length > 100 ? '...' : ''}\n`
  ).join('\n---\n');

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.ALERT_EMAIL,
    subject: `🚨 ${messages.length} Unanswered WhatsApp Messages`,
    html: `
      <div style="font-family: Arial;">
        <h2>Unanswered WhatsApp Messages</h2>
        <p>You have <strong>${messages.length}</strong> messages waiting for response:</p>
        <div style="background: #f5f5f5; padding: 15px; border-radius: 5px;">
          <pre style="white-space: pre-wrap;">${messageList}</pre>
        </div>
        <p><a href="http://localhost:${port}/dashboard">Click here to open management dashboard</a></p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Alert email sent successfully');
    
    // עדכון שההתראה נשלחה
    const messageIds = messages.map(m => m.id);
    db.run(`
      UPDATE messages 
      SET alert_sent = 1, last_alert_at = datetime('now')
      WHERE id IN (${messageIds.map(() => '?').join(',')})
    `, messageIds);
    
  } catch (error) {
    console.error('Error sending alert:', error);
  }
}

// Webhook verification (נדרש על ידי WhatsApp)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.log('Webhook verification failed');
    res.sendStatus(403);
  }
});

// Webhook לקבלת הודעות - משופר
app.post('/webhook', (req, res) => {
  try {
    const entry = req.body.entry;
    
    if (!entry || !Array.isArray(entry)) {
      return res.sendStatus(400);
    }

    entry.forEach(entryItem => {
      if (entryItem.changes) {
        entryItem.changes.forEach(change => {
          // טיפול בהודעות נכנסות
          if (change.value?.messages) {
            handleIncomingMessages(change.value.messages, change.value.contacts);
          }
          
          // טיפול בסטטוס הודעות (נקרא, נענה וכו')
          if (change.value?.statuses) {
            handleMessageStatuses(change.value.statuses);
          }
        });
      }
    });

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

// פונקציה לטיפול בהודעות נכנסות
function handleIncomingMessages(messages, contacts = []) {
  const contactMap = {};
  contacts.forEach(contact => {
    contactMap[contact.wa_id] = contact.profile?.name || contact.wa_id;
  });

  messages.forEach(msg => {
    const phoneNumber = msg.from;
    const contactName = contactMap[phoneNumber] || phoneNumber;
    const messageText = getMessageText(msg);
    const messageType = getMessageType(msg);

    // שמירת הודעה
    db.run(`
      INSERT OR IGNORE INTO messages 
      (message_id, phone_number, contact_name, message, message_type, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `, [msg.id, phoneNumber, contactName, messageText, messageType], function(err) {
      if (err) {
        console.error('Error saving message:', err.message);
      } else if (this.changes > 0) {
        console.log(`New message saved from ${contactName}: ${messageText.substring(0, 50)}...`);
        updateConversation(phoneNumber, contactName);
      }
    });
  });
}

// פונקציה לטיפול בסטטוסי הודעות
function handleMessageStatuses(statuses) {
  statuses.forEach(status => {
    if (status.status === 'read') {
      // אם הודעה נקראה, נסמן את השיחה כמטופלת
      db.run(`
        UPDATE messages 
        SET status = 'read', responded_at = datetime('now')
        WHERE message_id = ?
      `, [status.id]);
    }
  });
}

// פונקציה לחילוץ טקסט מהודעה
function getMessageText(msg) {
  if (msg.text) return msg.text.body;
  if (msg.image) return '[Image]' + (msg.image.caption || '');
  if (msg.video) return '[Video]' + (msg.video.caption || '');
  if (msg.audio) return '[Voice Message]';
  if (msg.document) return '[Document] ' + (msg.document.filename || '');
  if (msg.location) return '[Location]';
  return '[Unsupported Message]';
}

// פונקציה לזיהוי סוג הודעה
function getMessageType(msg) {
  if (msg.text) return 'text';
  if (msg.image) return 'image';
  if (msg.video) return 'video';
  if (msg.audio) return 'audio';
  if (msg.document) return 'document';
  if (msg.location) return 'location';
  return 'other';
}

// עדכון נתוני שיחה
function updateConversation(phoneNumber, contactName) {
  db.run(`
    INSERT OR REPLACE INTO conversations 
    (phone_number, contact_name, last_message_at, total_messages, unanswered_count)
    VALUES (
      ?, ?, datetime('now'),
      COALESCE((SELECT total_messages FROM conversations WHERE phone_number = ?), 0) + 1,
      COALESCE((SELECT unanswered_count FROM conversations WHERE phone_number = ?), 0) + 1
    )
  `, [phoneNumber, contactName, phoneNumber, phoneNumber]);
}

// בדיקה תקופתית להודעות שלא נענו
cron.schedule('*/5 * * * *', async () => { // כל 5 דקות
  const thresholdMinutes = process.env.ALERT_THRESHOLD_MINUTES || 60;
  
  db.all(`
    SELECT * FROM messages 
    WHERE status = 'pending' 
    AND alert_sent = 0
    AND datetime(received_at, '+' || ? || ' minutes') <= datetime('now')
    ORDER BY received_at ASC
  `, [thresholdMinutes], async (err, rows) => {
    if (err) {
      console.error('Error checking unanswered messages:', err);
      return;
    }
    
    if (rows.length > 0) {
      console.log(`Found ${rows.length} unanswered messages`);
      await sendAlert(rows);
    }
  });
});

// API endpoints לממשק ניהול
app.get('/api/messages', (req, res) => {
  db.all(`
    SELECT * FROM messages 
    ORDER BY received_at DESC 
    LIMIT 100
  `, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      res.json(rows);
    }
  });
});

app.get('/api/conversations', (req, res) => {
  db.all(`
    SELECT * FROM conversations 
    WHERE unanswered_count > 0
    ORDER BY last_message_at DESC
  `, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      res.json(rows);
    }
  });
});

app.post('/api/mark-responded/:messageId', (req, res) => {
  db.run(`
    UPDATE messages 
    SET status = 'responded', responded_at = datetime('now')
    WHERE id = ?
  `, [req.params.messageId], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      res.json({ success: true, changes: this.changes });
    }
  });
});

// דף בית פשוט
app.get('/', (req, res) => {
  res.send(`
    <div style="text-align: center; font-family: Arial; margin: 50px;">
      <h1>🚨 WhatsApp Alert System</h1>
      <p>System is running successfully!</p>
      <a href="/dashboard" style="background: #25D366; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
        Go to Management Dashboard
      </a>
    </div>
  `);
});

// דף ניהול פשוט
app.get('/dashboard', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>WhatsApp Messages Management</title>
        <style>
            body { font-family: Arial; margin: 20px; }
            .message { border: 1px solid #ddd; padding: 10px; margin: 10px 0; border-radius: 5px; }
            .pending { background-color: #ffe6e6; }
            .responded { background-color: #e6ffe6; }
            button { background: #25D366; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; }
        </style>
    </head>
    <body>
        <h1>🚨 WhatsApp Messages Management</h1>
        <div id="messages"></div>
        
        <script>
            async function loadMessages() {
                const response = await fetch('/api/messages');
                const messages = await response.json();
                const container = document.getElementById('messages');
                
                container.innerHTML = messages.map(msg => \`
                    <div class="message \${msg.status}">
                        <strong>\${msg.contact_name || msg.phone_number}</strong>
                        <small>(\${new Date(msg.received_at).toLocaleString()})</small>
                        <p>\${msg.message}</p>
                        \${msg.status === 'pending' ? 
                            \`<button onclick="markResponded(\${msg.id})">Mark as Responded</button>\` : 
                            '<span style="color: green;">✓ Responded</span>'
                        }
                    </div>
                \`).join('');
            }
            
            async function markResponded(messageId) {
                await fetch(\`/api/mark-responded/\${messageId}\`, { method: 'POST' });
                loadMessages();
            }
            
            loadMessages();
            setInterval(loadMessages, 30000); // Refresh every 30 seconds
        </script>
    </body>
    </html>
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err.message);
    } else {
      console.log('Database connection closed');
    }
    process.exit(0);
  });
});

// התחלת השרת
app.listen(port, () => {
  console.log(`WhatsApp Alert Server running at http://localhost:${port}`);
  console.log(`Dashboard available at: http://localhost:${port}/dashboard`);
});
