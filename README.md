# Shopify Chatbot Backend

## Quick start

1. Install dependencies:
   - `npm install`
2. Create your env file:
   - copy `.env.example` to `.env`
3. Fill in required variables in `.env`:
   - `OPENAI_API_KEY`
   - `DATABASE_URL`
4. Start the server:
   - `npm start`
5. Verify it runs:
   - API runs on `http://localhost:3000` (or your `PORT`)

## Notes

- Entry file: `server.js`
- Vercel config points to `server.js`
- Never commit `.env` (already ignored in `.gitignore`)
