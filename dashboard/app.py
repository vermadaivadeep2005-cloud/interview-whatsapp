import streamlit as st
import pandas as pd
from supabase import create_client, Client
import os
from dotenv import load_dotenv
import plotly.express as px
import requests

# Load environment variables from the parent directory .env file
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:3000")

st.set_page_config(page_title="Interview Dashboard", layout="wide")

@st.cache_resource
def init_connection() -> Client:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        st.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env")
        st.stop()
    return create_client(url, key)

supabase = init_connection()

# Fetch data functions
@st.cache_data(ttl=60)
def fetch_sessions():
    res = supabase.table("sessions").select("*").execute()
    return pd.DataFrame(res.data) if res.data else pd.DataFrame()

@st.cache_data(ttl=60)
def fetch_respondents():
    res = supabase.table("respondents").select("*").execute()
    return pd.DataFrame(res.data) if res.data else pd.DataFrame()

@st.cache_data(ttl=60)
def fetch_turns(session_id=None):
    if session_id:
        res = supabase.table("turns").select("*").eq("session_id", session_id).order("turn_number").execute()
    else:
        res = supabase.table("turns").select("*").execute()
    return pd.DataFrame(res.data) if res.data else pd.DataFrame()

@st.cache_data(ttl=60)
def fetch_tags():
    res = supabase.table("response_tags").select("*").execute()
    return pd.DataFrame(res.data) if res.data else pd.DataFrame()


# Sidebar navigation
st.sidebar.title("Interview WhatsApp")
page = st.sidebar.radio("Navigation", ["Overview", "Sessions & Transcripts", "Response Analysis", "Web Interview"])

if page == "Overview":
    st.title("Overview")
    
    sessions_df = fetch_sessions()
    respondents_df = fetch_respondents()
    
    if not sessions_df.empty:
        col1, col2, col3 = st.columns(3)
        col1.metric("Total Respondents", len(respondents_df))
        col2.metric("Total Sessions", len(sessions_df))
        completed = len(sessions_df[sessions_df['status'] == 'completed'])
        col3.metric("Completed Interviews", completed)
        
        st.subheader("Sessions Status")
        status_counts = sessions_df['status'].value_counts().reset_index()
        status_counts.columns = ['Status', 'Count']
        fig = px.pie(status_counts, values='Count', names='Status', title='Distribution of Session Statuses')
        st.plotly_chart(fig, width='stretch')
    else:
        st.info("No sessions found in the database.")

elif page == "Sessions & Transcripts":
    st.title("Sessions & Transcripts")
    
    sessions_df = fetch_sessions()
    if sessions_df.empty:
        st.info("No sessions found.")
    else:
        # Show sessions
        st.subheader("All Sessions")
        st.dataframe(sessions_df[['id', 'channel', 'status', 'last_activity_at', 'demographics']], width='stretch')
        
        st.subheader("View Transcript")
        session_ids = sessions_df['id'].tolist()
        
        # Display nicely in selectbox
        def format_session(sid):
            row = sessions_df[sessions_df['id'] == sid].iloc[0]
            name = "Unknown"
            if isinstance(row['demographics'], dict) and 'name' in row['demographics']:
                name = row['demographics']['name']
            return f"{sid} ({name} - {row['status']})"
            
        selected_session = st.selectbox("Select a Session to view transcript", session_ids, format_func=format_session)
        
        if selected_session:
            turns_df = fetch_turns(selected_session)
            if not turns_df.empty:
                st.markdown(f"### Transcript for Session: `{selected_session}`")
                
                # WhatsApp Custom CSS
                st.markdown("""
                <style>
                .wa-chat-container {
                    background-color: #0b141a;
                    background-image: url('https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png');
                    padding: 20px;
                    border-radius: 10px;
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    height: 500px;
                    overflow-y: auto;
                    border: 1px solid #333;
                }
                .wa-bubble {
                    max-width: 65%;
                    padding: 8px 12px;
                    border-radius: 7.5px;
                    font-family: 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif;
                    font-size: 14.2px;
                    line-height: 19px;
                    position: relative;
                    color: #e9edef;
                    word-wrap: break-word;
                }
                .wa-sent {
                    background-color: #005c4b;
                    align-self: flex-end;
                    border-top-right-radius: 0;
                }
                .wa-received {
                    background-color: #202c33;
                    align-self: flex-start;
                    border-top-left-radius: 0;
                }
                </style>
                """, unsafe_allow_html=True)

                import html
                chat_html = '<div class="wa-chat-container">'
                for _, row in turns_df.iterrows():
                    role = row['role']
                    content = html.escape(str(row['content'])).replace('\n', '<br>')
                    
                    if role == 'assistant':
                        chat_html += f'<div class="wa-bubble wa-sent">{content}</div>'
                    else:
                        chat_html += f'<div class="wa-bubble wa-received">{content}</div>'
                chat_html += '</div>'
                
                st.markdown(chat_html, unsafe_allow_html=True)
            else:
                st.write("No transcript available for this session.")

elif page == "Response Analysis":
    st.title("Response Analysis (AI Tags)")
    
    tags_df = fetch_tags()
    if tags_df.empty:
        st.info("No tags found.")
    else:
        st.dataframe(tags_df[['question_id', 'raw_response', 'economic_outcome', 'bottleneck_types', 'sentiment', 'confidence_in_tagging']], width='stretch')
        
        col1, col2 = st.columns(2)
        with col1:
            if 'economic_outcome' in tags_df.columns:
                st.subheader("Economic Outcomes")
                eco_counts = tags_df['economic_outcome'].value_counts().reset_index()
                eco_counts.columns = ['Outcome', 'Count']
                fig1 = px.bar(eco_counts, x='Outcome', y='Count', title="Economic Outcomes")
                st.plotly_chart(fig1, width='stretch')
        
        with col2:
            if 'sentiment' in tags_df.columns:
                st.subheader("Sentiment")
                sent_counts = tags_df['sentiment'].value_counts().reset_index()
                sent_counts.columns = ['Sentiment', 'Count']
                fig2 = px.pie(sent_counts, values='Count', names='Sentiment', title="Sentiment Analysis")
                st.plotly_chart(fig2, width='stretch')

elif page == "Web Interview":
    st.title("Web Interview Client")
    
    if "phone" not in st.session_state:
        st.session_state.phone = ""
    
    if not st.session_state.phone:
        st.markdown("### Welcome! Please enter your phone number or unique ID to start.")
        phone_input = st.text_input("Phone Number / ID")
        if st.button("Start Interview"):
            if phone_input:
                st.session_state.phone = phone_input
                st.rerun()
            else:
                st.error("Please enter a valid ID.")
    else:
        st.sidebar.markdown("---")
        st.sidebar.markdown(f"**Logged in as:** `{st.session_state.phone}`")
        if st.sidebar.button("Log Out"):
            st.session_state.phone = ""
            st.rerun()
        
        # We need to fetch the session ID for this phone to display history
        # Since we don't have a direct query for it in the dashboard, we can just fetch all and match
        sessions_df = fetch_sessions()
        respondents_df = fetch_respondents()
        
        session_id = None
        if not respondents_df.empty and not sessions_df.empty:
            respondent = respondents_df[respondents_df['phone'] == st.session_state.phone]
            if not respondent.empty:
                r_id = respondent.iloc[0]['id']
                user_sessions = sessions_df[sessions_df['respondent_id'] == r_id]
                if not user_sessions.empty:
                    session_id = user_sessions.iloc[0]['id']
        
        st.markdown("### Chat History")
        
        if session_id:
            turns_df = fetch_turns(session_id)
            if not turns_df.empty:
                import html
                chat_html = '<div style="background-color: #0b141a; padding: 20px; border-radius: 10px; display: flex; flex-direction: column; gap: 10px; height: 400px; overflow-y: auto; border: 1px solid #333;">'
                for _, row in turns_df.iterrows():
                    role = row['role']
                    content = html.escape(str(row['content'])).replace('\n', '<br>')
                    
                    if role == 'assistant':
                        chat_html += f'<div style="max-width: 75%; padding: 8px 12px; border-radius: 7.5px; font-family: sans-serif; font-size: 14px; background-color: #005c4b; align-self: flex-start; color: white;">{content}</div>'
                    else:
                        chat_html += f'<div style="max-width: 75%; padding: 8px 12px; border-radius: 7.5px; font-family: sans-serif; font-size: 14px; background-color: #202c33; align-self: flex-end; color: white;">{content}</div>'
                chat_html += '</div>'
                st.markdown(chat_html, unsafe_allow_html=True)
            else:
                st.info("No messages yet.")
        else:
            st.info("Say hello to start the interview!")
            
        st.markdown("---")
        
        # Input methods
        col1, col2 = st.columns([1, 1])
        
        with col1:
            st.markdown("**Send a Text Message**")
            with st.form("chat_form", clear_on_submit=True):
                user_input = st.text_input("Type your message here...")
                submitted = st.form_submit_button("Send")
                if submitted and user_input:
                    with st.spinner("Sending..."):
                        try:
                            headers = {"Bypass-Tunnel-Reminder": "true"}
                            resp = requests.post(f"{BACKEND_URL}/api/web-chat", json={"phone": st.session_state.phone, "text": user_input}, headers=headers)
                            if resp.status_code == 200:
                                st.rerun()
                            else:
                                st.error("Failed to send message.")
                        except Exception as e:
                            st.error(f"Error connecting to backend: {e}")

        with col2:
            st.markdown("**Or Send a Voice Message**")
            audio_value = st.audio_input("Record a voice note")
            if audio_value:
                with st.spinner("Uploading and processing audio..."):
                    try:
                        files = {'audio': ('recording.wav', audio_value.getvalue(), 'audio/wav')}
                        data = {'phone': st.session_state.phone}
                        headers = {"Bypass-Tunnel-Reminder": "true"}
                        resp = requests.post(f"{BACKEND_URL}/api/web-chat", data=data, files=files, headers=headers)
                        if resp.status_code == 200:
                            st.rerun()
                        else:
                            st.error("Failed to send audio.")
                    except Exception as e:
                        st.error(f"Error connecting to backend: {e}")
