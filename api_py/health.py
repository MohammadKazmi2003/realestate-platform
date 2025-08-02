# api_py/health.py
from fastapi import FastAPI

app = FastAPI()

@app.get("/api/health")
def health_check():
    return {"status": "ok", "message": "Python backend is running!"}