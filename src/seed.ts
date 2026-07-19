import { supabase } from './db';

async function seed() {
  console.log('Seeding protocol version 1.1.0...');

  // Deactivate any existing protocols
  const { error: deactivateError } = await supabase
    .from('protocols')
    .update({ is_active: false })
    .eq('is_active', true);

  if (deactivateError) {
    console.error('Failed to deactivate old protocols:', deactivateError);
  }

  const anchorQuestions = {
    consent: "Before we start: this will be recorded and transcribed, your responses will be anonymized in reporting, and you can stop at any point by saying 'stop.' OK to continue?",
    anchor_1: "Since the training, has anything changed in your income, job role, responsibilities, or opportunities — even something small? Tell me about it.",
    anchor_1_probe: "Was that a specific, datable thing — like a raise, promotion, or new client — or more of a general sense things have improved?",
    anchor_2: "What's the actual thing standing between you and using this to earn more or move up — is it opportunity, employer buy-in, confidence, the tools themselves, or something else?",
    anchor_2_probe: "Can you give me one specific recent moment where that got in the way?",
    anchor_3: "For what did change — was it more about doing your current job better, or about accessing something new: a role, a client, a side income?",
    anchor_3_probe: "What specifically did you do differently that led to that?",
    anchor_4: "Have you shared anything from the training with colleagues, or changed how your team works as a result? What happened?",
    anchor_4_probe: "What specifically did you share, and how did it land?",
    catch_all: "If AI literacy training could have done ONE more thing to actually move your income or opportunities, what would that have been?",
    wrap_up: "Is there anything else you would like to add that we have not yet discussed?",
    close: "Asante sana — that's everything I needed. Your responses will be anonymized and used to shape future training."
  };

  const codebook = {
    economic_outcome: {
      description: "Primary economic change observed in the respondent since training.",
      enum: ['income_increase', 'role_change_no_pay_change', 'improved_current_role_only', 'no_change', 'too_early_to_tell']
    },
    bottleneck_types: {
      description: "Specific barriers preventing further earnings/career growth.",
      enum: ['bottleneck_opportunity', 'bottleneck_employer_buyin', 'bottleneck_confidence', 'bottleneck_tooling_access', 'bottleneck_skill_gap', 'bottleneck_market', 'bottleneck_none_reported']
    },
    benefit_mechanism: {
      description: "How training translated into benefits, if any change occurred.",
      enum: ['efficiency_in_current_role', 'new_income_stream', 'internal_mobility', 'external_mobility', 'credibility_signal', 'not_applicable']
    },
    sentiment: {
      description: "Respondent's general attitude towards the training and their outcome.",
      enum: ['positive', 'neutral', 'negative', 'mixed']
    },
    swahili_vocabulary: {
      description: "Approved Swahili terms for localisation. The AI must use these at the correct trigger points — never more than ONE per response.",
      terms: {
        "Karibu":     { meaning: "Welcome",           trigger: "Initial onboarding and greeting phase" },
        "Safi sana!": { meaning: "Very cool! / Great!", trigger: "Only when respondent shares a strongly positive or highly insightful milestone" },
        "Sawa":       { meaning: "Okay / Alright",      trigger: "Acknowledgment prefix before transitioning to a new topic" },
        "Naam":       { meaning: "Yes / Indeed",        trigger: "Politeness marker when validating a tough or complex point" },
        "Usijali!":   { meaning: "Don't worry!",        trigger: "If respondent apologises for a long message, wants to skip, or makes an error" },
        "Asante sana":{ meaning: "Thank you very much", trigger: "Wrapping up a topic or closing the interview" }
      }
    }
  };

  const { data, error } = await supabase
    .from('protocols')
    .insert({
      version: '1.1.0',
      is_active: true,
      anchor_questions: anchorQuestions,
      codebook: codebook
    })
    .select()
    .single();

  if (error) {
    console.error('Error seeding protocol:', error);
    process.exit(1);
  }

  console.log('Successfully seeded protocol version 1.1.0! Protocol ID:', data.id);
  process.exit(0);
}

seed();
