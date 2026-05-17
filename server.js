import express from 'express';
import sqlite3 from 'better-sqlite3';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ============ CONFIG ============
const RESIDENT_PASSWORD = 'resident123';
const ADMIN_PASSWORD = 'admin123';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const PORT = process.env.PORT || 3000;

// ============ DATABASE SETUP ============
const db = new (await import('better-sqlite3')).default('./policies.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT UNIQUE NOT NULL,
    upload_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    content TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    sources TEXT,
    asked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const insertDoc = db.prepare('INSERT OR REPLACE INTO documents (filename, content) VALUES (?, ?)');
const getDocuments = db.prepare('SELECT * FROM documents ORDER BY upload_date DESC');
const deleteDoc = db.prepare('DELETE FROM documents WHERE id = ?');
const insertQuestion = db.prepare('INSERT INTO questions (question, answer, sources) VALUES (?, ?, ?)');

// ============ FILE UPLOAD ============
const upload = multer({ storage: multer.memoryStorage() });

// ============ UTILITIES ============
function chunkDocument(text, chunkSize = 800) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > chunkSize) {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }
  if (currentChunk) chunks.push(currentChunk.trim());

  return chunks;
}

function scoreChunkRelevance(chunk, question) {
  const qWords = question.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  const chunkLower = chunk.toLowerCase();
  return qWords.filter(word => chunkLower.includes(word)).length;
}

function findRelevantChunks(question, maxChunks = 5) {
  const allDocs = getDocuments.all();
  const candidates = [];

  for (const doc of allDocs) {
    const chunks = chunkDocument(doc.content);
    for (let i = 0; i < chunks.length; i++) {
      const score = scoreChunkRelevance(chunks[i], question);
      if (score > 0) {
        candidates.push({
          score,
          text: chunks[i],
          source: `${doc.filename}`,
          chunkIndex: i
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, maxChunks);
}

// ============ CLAUDE API ============
const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY
});

async function answerQuestion(question) {
  const relevantChunks = findRelevantChunks(question, 5);

  if (relevantChunks.length === 0) {
    return {
      answer: "I could not find relevant information in the policy documents to answer this question. Please contact the program leadership.",
      sources: []
    };
  }

  const chunksText = relevantChunks
    .map((chunk, i) => `[Source ${i + 1}: ${chunk.source}]\n${chunk.text}`)
    .join('\n\n---\n\n');

  const systemPrompt = `You are a Policy Q&A Assistant for a residency program. 
You MUST answer questions ONLY based on the provided policy documents.
If the documents don't contain the answer, say so clearly.
Be concise, professional, and cite which document the information comes from.
Always mention the document source in your answer.`;

  const userPrompt = `Based ONLY on these policy documents, answer this question:

Question: ${question}

Policy Documents:
${chunksText}

Provide a clear, concise answer citing the document sources.`;

  const response = await client.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const answer = response.content[0].type === 'text' ? response.content[0].text : '';
  const sources = relevantChunks.map(c => c.source);

  return { answer, sources: [...new Set(sources)] };
}

// ============ ROUTES ============
app.post('/api/login', (req, res) => {
  const { password, isAdmin } = req.body;

  if (isAdmin && password === ADMIN_PASSWORD) {
    return res.json({ success: true, role: 'admin', token: 'admin_token_' + Date.now() });
  }

  if (!isAdmin && password === RESIDENT_PASSWORD) {
    return res.json({ success: true, role: 'resident', token: 'resident_token_' + Date.now() });
  }

  res.status(401).json({ success: false, error: 'Invalid password' });
});

app.get('/api/documents', (req, res) => {
  const { token } = req.query;
  if (!token || !token.startsWith('admin_token_')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const docs = getDocuments.all();
  res.json(docs);
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const { token } = req.body;
  if (!token || !token.startsWith('admin_token_')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const pdfData = await pdfParse(req.file.buffer);
    const filename = req.file.originalname;
    const content = pdfData.text;

    insertDoc.run(filename, content);

    res.json({ success: true, message: `Document "${filename}" uploaded successfully` });
  } catch (err) {
    res.status(500).json({ error: `Failed to process PDF: ${err.message}` });
  }
});

app.delete('/api/documents/:id', (req, res) => {
  const { token } = req.query;
  if (!token || !token.startsWith('admin_token_')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  deleteDoc.run(req.params.id);
  res.json({ success: true, message: 'Document deleted' });
});

app.post('/api/ask', async (req, res) => {
  const { token, question } = req.body;

  if (!token || (!token.startsWith('resident_token_') && !token.startsWith('admin_token_'))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!question || question.trim().length === 0) {
    return res.status(400).json({ error: 'Question is required' });
  }

  try {
    const result = await answerQuestion(question);
    insertQuestion.run(question, result.answer, JSON.stringify(result.sources));
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: `Failed to process question: ${err.message}` });
  }
});

// ============ SERVER START ============
app.listen(PORT, () => {
  console.log(`🚀 Policy Q&A Agent running on port ${PORT}`);
  console.log(`Resident Password: ${RESIDENT_PASSWORD}`);
  console.log(`Admin Password: ${ADMIN_PASSWORD}`);
  console.log(`Make sure CLAUDE_API_KEY is set!`);
});
