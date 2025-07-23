// adminMailApi.js
const express = require("express");
const router = express.Router();
const fs = require("fs");
const imap = require("imap-simple");
const adminAuth = require("../middleware/authAdmin");
const { simpleParser } = require("mailparser");
const execSync = require("child_process").execSync;

// const crypto = require('crypto');

// // Generate a random 64-byte hex string
// const secretKey = crypto.randomBytes(64).toString('hex');
// console.log(secretKey);

// const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY; // Stored securely
// const adminPayload = {
//   role: 'admin',
//   email: 'admin@sharda.co.in'
// };

// const adminToken = jwt.sign(adminPayload, ADMIN_SECRET_KEY, { expiresIn: '1h' });

// console.log(adminToken);



const folderMap = {
  inbox: "INBOX",
  sent: "Sent",
  drafts: "Drafts",
  trash: "Trash",
  archived: "Archive",
  star: "INBOX",
  social: "INBOX",
  promotions: "INBOX",
};

// Helper function to compare hashed passwords



router.get("/admin/list-email-users", (req, res) => {
  try {
    const data = fs.readFileSync("/etc/dovecot/users", "utf8");
    const users = data
      .split("\n")
      .filter((line) => line.trim() !== "") // Remove empty lines
      .map((line) => {
        const [email, password] = line.split(":"); // Split email and password
        return { email, password }; // Include both email and password
      });
    res.json({ users }); // Return both email and password
  } catch (err) {
    res.status(500).json({ error: "Failed to read users." });
  }
});

// --- 3. Get all mails for any user (admin) ---
router.get("/admin/get-mails", adminAuth, async (req, res) => {
  let connection;
  try {
    const { email, folder = "INBOX", page = 1, pageSize = 100 } = req.query;
    if (!email) return res.status(400).json({ error: "Email is required" });

    // Folder mapping
    const folderMap = {
      inbox: "INBOX",
      sent: "Sent",
      drafts: "Drafts",
      trash: "Trash",
      archived: "Archive",
      star: "INBOX",
      social: "INBOX",
      promotions: "INBOX",
    };
    const targetFolder = folderMap[(folder || "inbox").toLowerCase()] || folder || "INBOX";

    // IMAP connection as master user (admin rights)
    const imapConfig = {
      imap: {
        user: `${email}*admin`, // Master user
        password: process.env.MAILBOX_MASTER_PASSWORD,
        host: "mail.sharda.co.in",
        port: 993,
        tls: true,
        authTimeout: 10000,
      }
    };

    connection = await imap.connect(imapConfig);
    await connection.openBox(targetFolder);

    // 1. Get all messages' UIDs, newest first
    const searchResults = await connection.search(['ALL'], { bodies: [], struct: true });
    const total = searchResults.length;
    if (!total) {
      await connection.end();
      return res.json({ success: true, emails: [], total: 0 });
    }
    searchResults.reverse(); // Newest first

    // 2. Paginate
    const pageSizeNum = parseInt(pageSize, 10);
    const pageNum = parseInt(page, 10);
    const paged = searchResults.slice((pageNum - 1) * pageSizeNum, pageNum * pageSizeNum);
    const uids = paged.map(msg => ({
      uid: msg.attributes.uid,
      flags: msg.attributes.flags || [],
    }));

    // 3. Fetch messages
    const emails = await Promise.all(
      uids.map(({ uid, flags }) => {
        return new Promise((resolve, reject) => {
          const fetcher = connection.imap.fetch(uid, {
            bodies: '',  // <-- THIS IS THE WORKING BIT
            struct: true
          });
          let raw = '';
          fetcher.on('message', (msg) => {
            msg.on('body', (stream) => {
              stream.on('data', (chunk) => { raw += chunk.toString('utf8'); });
              stream.once('end', async () => {
                try {
                  const parsed = await simpleParser(raw);
                  resolve({
                    uid,
                    subject: parsed.subject || '(No Subject)',
                    from: parsed.from?.text || '',
                    to: parsed.to?.text || '',
                    cc: parsed.cc?.text || '',
                    bcc: parsed.bcc?.text || '',
                    date: parsed.date || '',
                    body: parsed.html || parsed.text || '',
                    text: parsed.text || '',
                    attachments: (parsed.attachments || []).map((att, idx) => ({
                      filename: att.filename || `attachment-${idx}`,
                      contentType: att.contentType,
                      size: att.size,
                      content: att.content.toString('base64'),
                      index: idx,
                    })),
                    read: Array.isArray(flags) && flags.includes('\\Seen'),
                    flags,
                  });
                } catch (err) { reject(err); }
              });
            });
            msg.once('error', reject);
          });
          fetcher.once('error', reject);
        });
      })
    );

    await connection.end();
    return res.json({ success: true, emails, total });

  } catch (err) {
    if (connection) {
      try { await connection.end(); } catch (e) { }
    }
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


router.get("/admin/get-attachment", async (req, res) => {
  const { email, uid, folder = "INBOX", index } = req.query;
  const token = req.headers['authorization']; // Fetch the token from the header

  console.log("Received parameters:", { email, uid, folder, index });

  if (!email || !uid || index === undefined) {
    return res.status(400).json({ success: false, message: "Missing parameters" });
  }

  // Check if the token exists and is valid (admin authentication)
  if (!token || !token.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  // Extract token and verify
  const adminToken = token.split(' ')[1]; // Extract token part from 'Bearer <token>'

  try {
    const decoded = jwt.verify(adminToken, ADMIN_SECRET_KEY);
    console.log("Admin authenticated:", decoded);
  } catch (err) {
    console.error("Invalid or expired token:", err);
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  // Fetch user data from Dovecot users file (password check is skipped)
  try {
    const usersData = fs.readFileSync("/etc/dovecot/users", "utf8");
    const users = usersData.split("\n").filter(line => line.trim() !== "");

    // Find the user entry for the given email
    const user = users.find(line => line.split(":")[0] === email);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Proceed to fetch attachments after successful authentication
    const box = folderMap[folder.toLowerCase()] || "INBOX";

    const config = {
      imap: {
        user: email,
        password: '', // Password is skipped, as we are authenticating admin
        host: "mail.sharda.co.in",
        port: 993,
        tls: true,
        authTimeout: 5000,
        tlsOptions: { rejectUnauthorized: false },
      },
    };

    let connection;
    try {
      console.log("Connecting to IMAP server...");
      connection = await imap.connect(config);
      await connection.openBox(box);

      const allMessages = await connection.search(['ALL'], { bodies: [''], struct: true });
      const message = allMessages.find(msg => msg.attributes.uid == uid);

      if (!message) {
        return res.status(404).json({ success: false, message: "Mail not found" });
      }

      const raw = message.parts[0].body;
      const parsed = await simpleParser(raw);

      const att = parsed.attachments[parseInt(index)];
      if (!att) {
        return res.status(404).json({ success: false, message: "Attachment not found" });
      }

      res.setHeader("Content-Type", att.contentType || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${att.filename}"`);
      res.send(att.content);

      await connection.end();
    } catch (err) {
      if (connection) await connection.end();
      console.error(err);
      return res.status(500).json({ success: false, error: err.message });
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: "Failed to read users file" });
  }
});
module.exports = router;
