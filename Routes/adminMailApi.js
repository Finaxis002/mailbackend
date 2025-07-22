// adminMailApi.js
const express = require("express");
const router = express.Router();
const fs = require("fs");
const imap = require("imap-simple");
const adminAuth = require("../middleware/authAdmin");
const Imap = require('node-imap');
const { simpleParser } = require("mailparser");

// --- 1. List all users ---

router.get("/admin/list-email-users", (req, res) => {
  try {
    const data = fs.readFileSync("/etc/dovecot/users", "utf8");
    const users = data
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const email = line.split(":")[0];
        return { email };
      });
    res.json({ users });
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
module.exports = router;
