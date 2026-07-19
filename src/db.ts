import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment variables.');
}

// Create a Supabase client with the service role key to bypass Row Level Security
export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

export interface Respondent {
  id: string;
  phone: string;
  cohort: string | null;
  invited_at: string;
}

export interface RespondentAnonMap {
  respondent_id: string;
  anon_id: string;
}

export interface Protocol {
  id: string;
  version: string;
  is_active: boolean;
  anchor_questions: any; // JSON containing questions
  codebook: any; // JSON containing codebook
}

export interface Session {
  id: string;
  respondent_id: string;
  protocol_id: string;
  channel: string;
  status: 'invited' | 'consented' | 'in_progress' | 'completed' | 'abandoned' | 'declined';
  consent_given: boolean;
  last_activity_at: string | null;
  nudge_sent_at: string | null;
  completed_at: string | null;
  respondent_phone?: string; // virtual field for joins
}

export interface Turn {
  id: string;
  session_id: string;
  turn_number: number;
  role: 'assistant' | 'respondent';
  content: string;
  question_id: string | null;
  input_mode: 'text' | 'voice' | null;
}

export interface ResponseTag {
  id: string;
  session_id: string;
  turn_id: string | null;
  question_id: string;
  source: 'live' | 'batch_audit';
  raw_response: string;
  economic_outcome: string | null;
  bottleneck_types: string[] | null;
  benefit_mechanism: string | null;
  sentiment: string | null;
  confidence_in_tagging: number | null;
  transcription_confidence: number | null;
  quotable_snippet: string | null;
}

// Database helper functions

export const db = {
  /**
   * Resolves a phone number to an active session, creating the respondent/session if necessary.
   */
  async getOrCreateSessionForPhone(phone: string): Promise<Session> {
    // 1. Check if respondent exists
    let { data: respondent, error: rError } = await supabase
      .from('respondents')
      .select('*')
      .eq('phone', phone)
      .maybeSingle();

    if (rError) throw rError;

    if (!respondent) {
      // Create new respondent
      const { data: newRespondent, error: insertRError } = await supabase
        .from('respondents')
        .insert({ phone, cohort: 'Initial Cohort' })
        .select()
        .single();

      if (insertRError) throw insertRError;
      respondent = newRespondent;

      // Create anon map entry
      const { error: mapError } = await supabase
        .from('respondent_anon_map')
        .insert({ respondent_id: respondent.id }); // default anon_id triggers automatically in SQL

      if (mapError) throw mapError;
    }

    // 2. Fetch the active protocol
    const { data: protocol, error: pError } = await supabase
      .from('protocols')
      .select('*')
      .eq('is_active', true)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pError) throw pError;
    if (!protocol) {
      throw new Error('No active protocol found in database. Run the seed script first!');
    }

    // 3. Look for an active session (invited, consented, or in_progress)
    let { data: session, error: sError } = await supabase
      .from('sessions')
      .select('*')
      .eq('respondent_id', respondent.id)
      .in('status', ['invited', 'consented', 'in_progress'])
      .maybeSingle();

    if (sError) throw sError;

    if (!session) {
      // Create a new session
      const { data: newSession, error: insertSError } = await supabase
        .from('sessions')
        .insert({
          respondent_id: respondent.id,
          protocol_id: protocol.id,
          status: 'invited',
          consent_given: false,
          last_activity_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (insertSError) throw insertSError;
      session = newSession;
    }

    return session as Session;
  },

  async getSession(sessionId: string): Promise<Session> {
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (error) throw error;
    return data as Session;
  },

  async getProtocol(protocolId: string): Promise<Protocol> {
    const { data, error } = await supabase
      .from('protocols')
      .select('*')
      .eq('id', protocolId)
      .single();

    if (error) throw error;
    return data as Protocol;
  },

  async getProtocolForSession(sessionId: string): Promise<Protocol> {
    const session = await this.getSession(sessionId);
    return this.getProtocol(session.protocol_id);
  },

  /**
   * Retrieves the message history formatted for the Anthropic/Claude API.
   * Maps 'respondent' role to 'user', and 'assistant' to 'assistant'.
   */
  async getHistory(sessionId: string): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const { data: turns, error } = await supabase
      .from('turns')
      .select('*')
      .eq('session_id', sessionId)
      .order('turn_number', { ascending: true });

    if (error) throw error;

    return (turns || []).map((t: Turn) => ({
      role: t.role === 'respondent' ? 'user' : 'assistant',
      content: t.content,
    }));
  },

  async getFullTranscript(sessionId: string): Promise<Turn[]> {
    const { data: turns, error } = await supabase
      .from('turns')
      .select('*')
      .eq('session_id', sessionId)
      .order('turn_number', { ascending: true });

    if (error) throw error;
    return turns as Turn[];
  },

  async appendTurn(
    sessionId: string,
    role: 'assistant' | 'respondent',
    content: string,
    inputMode: 'text' | 'voice' = 'text',
    questionId: string | null = null
  ): Promise<Turn> {
    // 1. Fetch current turn count to calculate the next turn_number
    const { count, error: countError } = await supabase
      .from('turns')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', sessionId);

    if (countError) throw countError;
    const turnNumber = (count || 0) + 1;

    // 2. Insert the new turn
    const { data: newTurn, error: insertError } = await supabase
      .from('turns')
      .insert({
        session_id: sessionId,
        turn_number: turnNumber,
        role,
        content,
        question_id: questionId,
        input_mode: inputMode,
      })
      .select()
      .single();

    if (insertError) throw insertError;
    return newTurn as Turn;
  },

  async saveTag(sessionId: string, tagData: Omit<ResponseTag, 'id' | 'session_id' | 'source'> & { turn_id: string | null }) {
    const { error } = await supabase
      .from('response_tags')
      .insert({
        session_id: sessionId,
        source: 'live',
        ...tagData,
      });

    if (error) throw error;
  },

  async saveBatchTags(sessionId: string, tags: Array<any>) {
    const formattedTags = tags.map((t) => ({
      session_id: sessionId,
      source: 'batch_audit',
      question_id: t.question_id,
      raw_response: t.raw_response,
      economic_outcome: t.economic_outcome || null,
      bottleneck_types: t.bottleneck_types || null,
      benefit_mechanism: t.benefit_mechanism || null,
      sentiment: t.sentiment || null,
      confidence_in_tagging: t.confidence_in_tagging || null,
      transcription_confidence: t.transcription_confidence || null,
      quotable_snippet: t.quotable_snippet || null,
    }));

    const { error } = await supabase
      .from('response_tags')
      .insert(formattedTags);

    if (error) throw error;
  },

  async updateSessionActivity(sessionId: string) {
    const { error } = await supabase
      .from('sessions')
      .update({ last_activity_at: new Date().toISOString() })
      .eq('id', sessionId);

    if (error) throw error;
  },

  async updateSessionStatus(
    sessionId: string,
    status: Session['status'],
    consentGiven?: boolean
  ) {
    const updates: Partial<Session> = { status };
    if (consentGiven !== undefined) {
      updates.consent_given = consentGiven;
    }
    if (status === 'completed') {
      updates.completed_at = new Date().toISOString();
    }

    const { error } = await supabase
      .from('sessions')
      .update(updates)
      .eq('id', sessionId);

    if (error) throw error;
  },

  async markNudgeSent(sessionId: string) {
    const { error } = await supabase
      .from('sessions')
      .update({ nudge_sent_at: new Date().toISOString() })
      .eq('id', sessionId);

    if (error) throw error;
  },

  async markAbandoned(sessionId: string) {
    const { error } = await supabase
      .from('sessions')
      .update({ status: 'abandoned' })
      .eq('id', sessionId);

    if (error) throw error;
  },

  // Helper to resolve an anonymous ID to the respondent's phone (only used for server-side logging/nudge triggers)
  async getPhoneForSession(sessionId: string): Promise<string> {
    const { data, error } = await supabase
      .from('sessions')
      .select('respondents (phone)')
      .eq('id', sessionId)
      .single();

    if (error) throw error;
    const phone = (data as any).respondents?.phone;
    if (!phone) throw new Error('Phone not found for session');
    return phone;
  },
};
