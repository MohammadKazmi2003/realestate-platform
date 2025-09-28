import os
import re
from dotenv import load_dotenv, find_dotenv

# --- Configuration & Initialization ---

# Use find_dotenv() to automatically locate the .env file in the project root
load_dotenv(find_dotenv())

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import spacy
from spacy.matcher import Matcher
from typing import Dict, Any, List, Optional, Tuple
from pydantic import BaseModel, Field
import groq
from supabase import create_client, Client
import logging
from datetime import datetime
from cachetools import TTLCache
from api_py.shared_embedding import embedding_engine
# Logging Configuration
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Environment Variables
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")

if not all([SUPABASE_URL, SUPABASE_KEY, GROQ_API_KEY]):
    raise ValueError("Missing required environment variables (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY, GROQ_API_KEY)")

# API Clients
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
llm = groq.Client(api_key=GROQ_API_KEY)
app = FastAPI()

# spaCy & Embedding Models
try:
    nlp = spacy.load("en_core_web_lg")

except OSError:
    logging.error("SpaCy model or SentenceTransformer not found. Please run 'pip install en_core_web_lg sentence-transformers'.")
    nlp = None
    embedding_model = None

# In-memory cache for conversation state
conversation_cache = TTLCache(maxsize=1000, ttl=3600)


# --- Pydantic Models ---
class Message(BaseModel):
    role: str
    content: str

class PropertyCard(BaseModel):
    id: str
    title: Optional[str] = None
    listing_type: Optional[str] = None
    image_url: Optional[str] = None
    price: Optional[float] = None
    location: Optional[str] = None
    bedrooms: Optional[int] = None
    page_link: Optional[str] = None
    description: Optional[str] = None

class ChatRequest(BaseModel):
    messages: List[Message]
    session_id: str
    session_state: Optional[Dict[str, Any]] = {}

class ChatResponse(BaseModel):
    text_response: str
    properties: List[PropertyCard] = []
    session_state: Dict[str, Any]

class SearchParameters(BaseModel):
    locations: List[str] = Field(default_factory=list)
    property_types: List[str] = Field(default_factory=list)
    min_price: Optional[float] = None
    max_price: Optional[float] = None
    min_bedrooms: Optional[int] = None
    amenities: List[str] = Field(default_factory=list)

class ConversationState(BaseModel):
    session_id: str
    history: List[Message] = Field(default_factory=list)
    search_params: SearchParameters = Field(default_factory=SearchParameters)
    last_search_results: List[Dict[str, Any]] = Field(default_factory=list)
    focused_property_id: Optional[str] = None
    shown_ids: List[str] = Field(default_factory=list)
    last_updated: datetime = Field(default_factory=datetime.utcnow)

# --- Domain Knowledge ---
DOMAIN_SYNONYMS = {"payment_plan": ["payment schedule", "installment plan"], "price": ["cost", "budget"]}
AMENITIES_KEYWORDS = ["pool", "gym", "parking", "balcony", "security", "garden", "playground"]
PROPERTY_TYPE_KEYWORDS = ["apartment", "villa", "townhouse", "penthouse", "land", "commercial"]

# --- Core Logic ---
class NLUProcessor:
    def __init__(self, nlp_model):
        self.nlp = nlp_model

    def extract_entities(self, text: str) -> Dict[str, Any]:
        if not self.nlp: return {}
        doc = self.nlp(text.lower())
        entities = {
            "locations": [ent.text.title() for ent in doc.ents if ent.label_ in ["GPE", "LOC"]],
            "prices": [float(ent.text) for ent in doc.ents if ent.label_ == "MONEY"],
            "numbers": [int(token.text) for token in doc if token.like_num and token.is_digit],
            "amenities": [token.lemma_ for token in doc if token.lemma_ in AMENITIES_KEYWORDS],
            "property_types": [token.lemma_ for token in doc if token.lemma_ in PROPERTY_TYPE_KEYWORDS]
        }
        return entities

    def classify_intent(self, text: str, state: ConversationState) -> str:
        text = text.lower()
        if any(kw in text for kw in ["search", "find", "look for", "show me"]): return "SEARCH"
        if state.last_search_results:
            if any(kw in text for kw in ["first one", "second one", "third one", "last one"]): return "SELECT_PROPERTY"
            if any(kw in text for kw in DOMAIN_SYNONYMS["payment_plan"] + ["payment plan", "price", "how much"]): return "GET_DETAILS"
        return "REFINE_SEARCH"

class ConversationManager:
    @staticmethod
    def get_state(session_id: str, initial_state: dict) -> ConversationState:
        if session_id in conversation_cache: return conversation_cache[session_id]
        return ConversationState(session_id=session_id, **initial_state)

    @staticmethod
    def save_state(state: ConversationState):
        state.last_updated = datetime.utcnow()
        conversation_cache[state.session_id] = state

    @staticmethod
    def update_search_params(state: ConversationState, entities: dict) -> ConversationState:
        params = state.search_params
        if entities.get("locations"): params.locations = list(set(params.locations + entities["locations"]))
        if entities.get("property_types"): params.property_types = list(set(params.property_types + entities["property_types"]))
        if entities.get("prices"): params.max_price = entities["prices"][0]
        if entities.get("numbers"): params.min_bedrooms = entities["numbers"][0]
        if entities.get("amenities"): params.amenities = list(set(params.amenities + entities["amenities"]))
        state.search_params = params
        return state

class SearchHandler:
    @staticmethod
    def search_properties(params: SearchParameters, exclude_ids: List[str]) -> List[Dict[str, Any]]:
        try:
            # ** FIX **: Parameters are now passed as lists (arrays) to match the SQL function.
            rpc_params = {
                "p_property_types": params.property_types or None,
                "p_locations": params.locations or None,
                "p_min_price": params.min_price,
                "p_max_price": params.max_price,
                "p_min_bedrooms": params.min_bedrooms,
                "p_amenities": params.amenities or None,
                "p_exclude_ids": exclude_ids or None
            }
            logging.info(f"Filtered search with corrected params: {rpc_params}")
            response = supabase.rpc("search_all_properties", rpc_params).execute()
            return response.data or []
        except Exception as e:
            logging.error(f"Filtered search failed: {e}")
            return []

    @staticmethod
    def semantic_search(query: str, exclude_ids: List[str]) -> List[Dict[str, Any]]:
        if not embedding_model: return []
        try:
            embedding = embedding_engine.embed_query(query)
            params = {"query_embedding": embedding, "match_threshold": 0.6, "match_count": 20, "p_exclude_ids": exclude_ids or None}
            logging.info(f"Semantic search for: '{query}'")
            return supabase.rpc("semantic_search_properties", params).execute().data or []
        except Exception as e:
            logging.error(f"Semantic search failed: {e}")
            return []

class ResponseGenerator:
    @staticmethod
    def generate_response(prompt: str, messages: List[Message]) -> str:
        try:
            system_message = {"role": "system", "content": "You are a helpful and concise real estate assistant."}
            user_prompt = {"role": "user", "content": prompt}
            history = [msg.dict() for msg in messages[-4:]]
            completion = llm.chat.completions.create(
                model="llama3-70b-8192", messages=[system_message, *history, user_prompt],
                temperature=0.3, max_tokens=1024
            )
            return completion.choices[0].message.content
        except Exception as e:
            logging.error(f"Groq API call failed: {e}")
            return "I'm sorry, an unexpected error occurred."

    def summary_of_results(self, properties: List[Dict], query: str, messages: List[Message]) -> str:
        if not properties: return "I couldn't find any properties matching your criteria. Would you like to try a different search?"
        
        prop_summaries = []
        for p in properties[:5]:
            prop_summaries.append(f"- **{p.get('title')}** in {p.get('location')} for AED {p.get('price'):,}")
        
        summaries_text = "\n".join(prop_summaries)
        prompt = f"""
        User asked: "{query}"
        I found {len(properties)} properties. Here are the top results:
        {summaries_text}
        
        Please provide a friendly, brief summary of these findings and ask if the user wants more details on one or to refine the search.
        """
        return self.generate_response(prompt, messages)

    def single_property_details(self, prop: Dict, detail_request: str, messages: List[Message]) -> str:
        prompt = f"""
        The user is asking for details about the property: "{prop.get('title')}"
        Their specific question is: "{detail_request}"
        
        Here is the property's information:
        - Description: {prop.get('description')}
        - Payment Plan: {prop.get('payment_plan')}
        - Handover Year: {prop.get('handover_year')}
        
        Answer the user's question based *only* on the provided information. If a detail is not present, say so.
        """
        return self.generate_response(prompt, messages)

# --- FastAPI App ---
app = FastAPI()
nlu_processor = NLUProcessor(nlp)
response_generator = ResponseGenerator()

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    try:
        state = ConversationManager.get_state(req.session_id, req.session_state)
        state.history.extend(req.messages)
        user_msg = req.messages[-1].content

        entities = nlu_processor.extract_entities(user_msg)
        state = ConversationManager.update_search_params(state, entities)
        intent = nlu_processor.classify_intent(user_msg, state)
        logging.info(f"Session: {req.session_id}, Intent: {intent}")

        text_response, properties = "", []

        if intent in ["SEARCH", "REFINE_SEARCH"]:
            # Switch to semantic search for broad, non-specific queries
            if not any([state.search_params.locations, state.search_params.property_types, state.search_params.min_price, state.search_params.max_price, state.search_params.min_bedrooms]):
                results = SearchHandler.semantic_search(user_msg, state.shown_ids)
            else:
                results = SearchHandler.search_properties(state.search_params, state.shown_ids)
            
            if not results:
                text_response = "I couldn't find any properties matching your new criteria. You can try broadening your search."
            else:
                state.last_search_results = results
                state.shown_ids.extend([str(p['id']) for p in results])
                text_response = response_generator.summary_of_results(results, user_msg, state.history)
                properties = [PropertyCard(**p) for p in results[:5]]

        elif intent == "SELECT_PROPERTY":
            idx = -1
            if "first" in user_msg.lower(): idx = 0
            elif "second" in user_msg.lower(): idx = 1
            
            if 0 <= idx < len(state.last_search_results):
                prop = state.last_search_results[idx]
                state.focused_property_id = str(prop.get('id'))
                text_response = response_generator.single_property_details(prop, "Tell me more about it.", state.history)
                properties = [PropertyCard(**prop)]
            else:
                text_response = "Sorry, I couldn't figure out which property you meant."

        elif intent == "GET_DETAILS" and state.focused_property_id:
            prop = next((p for p in state.last_search_results if str(p.get('id')) == state.focused_property_id), None)
            if prop:
                text_response = response_generator.single_property_details(prop, user_msg, state.history)
                properties = [PropertyCard(**prop)]
            else:
                text_response = "I've lost track of the property. Could you clarify?"
        else:
            text_response = response_generator.generate_response(user_msg, state.history)

        ConversationManager.save_state(state)
        return ChatResponse(text_response=text_response, properties=properties, session_state=state.dict(exclude={'history'}))

    except Exception as e:
        logging.error(f"Chat endpoint error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="An internal server error occurred.")

@app.get("/")
def read_root(): return {"status": "ok"}

