# Real Estate Platform — First-Time Setup (Mac + Windows)

Runs **fully locally**. No remote DB needed. Images are URLs in the DB (`property-images` bucket for uploads, external URLs otherwise) — local Supabase handles it.

## 1. Get the code
Download the GitHub ZIP, extract it, open the folder in terminal:
```bash
cd realestate-platform
```

## 2. Install tools
Install: `Node 20 LTS`, `Python 3.11`, `Git`, `Docker Desktop`.
Install Supabase CLI:
```bash
# Mac
brew install supabase/tap/supabase
# Windows (Admin PowerShell)
scoop install supabase
```

## 3. Env file
```bash
# Mac
cp .env.example .env
# Windows
copy .env.example .env
```
Paste only 3 keys into `.env`: `GROQ_API_KEY` (console.groq.com), `TAVILY_API_KEY` (tavily.com), `NEXT_PUBLIC_MAPTILER_KEY` (maptiler.com). Supabase URLs/keys already have safe local defaults. Get Supabase keys: local = `supabase status`, remote = Dashboard > Settings > API.

## 4. Frontend deps
```bash
npm install
```

## 5. Python venv + deps (chatbot)
```bash
# Mac
python3 -m venv venv
source venv/bin/activate
# Windows
py -m venv venv
venv\Scripts\activate
```
```bash
pip install -r requirements.txt
```
No torch/transformers needed — semantic search is optional and disabled by default.

## 6. Database (local)
```bash
supabase start
supabase db reset
```
This creates schema from `supabase/migrations/` + empty `property-images` bucket. For same data as another PC: copy its `local_complete_data.sql` and run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f local_complete_data.sql
```
Remote instead (optional): put remote URL + anon key in `.env` and skip `supabase start`.

## 7. Start (2 terminals)
```bash
# Terminal 1 — backend, venv activated
uvicorn api_py.search:app --host 0.0.0.0 --port 8000 --reload
# Terminal 2
npm run dev
```

## 8. Verify
- App: `http://localhost:3000`
- Backend: `http://localhost:8000/docs`
- Studio: `http://127.0.0.1:54323`, Mail: `http://127.0.0.1:54324`
- Sign up → confirm in Inbucket → sign in → sign out → forgot-password.
- Check `/browse` (filters + map), `/newprojects`, `/property/[id]`, chat box.
