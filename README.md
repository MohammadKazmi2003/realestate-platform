# Real Estate Platform — Setup (Mac + Windows)

Runs fully locally. The database starts empty — you add your own data.

## 1. Get the code
Download the GitHub ZIP, extract it, open a terminal in the folder:
```bash
cd realestate-platform
```

## 2. Install tools
Install `Node 20 LTS`, `Python 3.11`, `Git`, `Docker Desktop`, then the Supabase CLI:
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
Open `.env` and paste 3 keys: `GROQ_API_KEY` (console.groq.com), `TAVILY_API_KEY` (tavily.com), `NEXT_PUBLIC_MAPTILER_KEY` (maptiler.com). The rest already has local defaults.

## 4. Install dependencies
```bash
npm install
```

## 5. Chatbot deps
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

## 6. Database
```bash
supabase start
supabase db reset
```

## 7. Start (2 terminals)
```bash
# Terminal 1 (venv activated)
uvicorn api_py.search:app --host 0.0.0.0 --port 8000 --reload
# Terminal 2
npm run dev
```

## 8. Check it works
- App: `http://localhost:3000`
- Sign up, then sign in and sign out.
- Open `/browse` and `/newprojects`, add a property and see it listed.
