const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const PDFParse = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs').promises;
require('dotenv').config();


const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);


const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);



// 👇 model name should NOT have "models/"
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Configure Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'application/msword', 
                         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                         'text/plain'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Please upload PDF, DOC, DOCX, or TXT files.'));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Extract text from different file types
async function extractTextFromFile(filePath, mimeType) {
  try {
    switch (mimeType) {
      case 'application/pdf':
        const pdfBuffer = await fs.readFile(filePath);
        const pdfData = await PDFParse(pdfBuffer);
        return pdfData.text;

      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        const docxBuffer = await fs.readFile(filePath);
        const docxResult = await mammoth.extractRawText({ buffer: docxBuffer });
        return docxResult.value;

      case 'text/plain':
        const txtContent = await fs.readFile(filePath, 'utf8');
        return txtContent;

      default:
        throw new Error('Unsupported file type');
    }
  } catch (error) {
    console.error('Error extracting text:', error);
    throw error;
  }
}


app.post("/api/interview/start", async (req, res) => {
  try {
    const { userId } = req.body;  // Optional: if you have user authentication

    // Create new session in database
    const { data, error } = await supabase
      .from("interview_sessions")
      .insert({ 
        status: 'in_progress',
        user_id: userId || null  // Optional
      })
      .select()
      .single();

    if (error) {
      console.error("❌ Session creation error:", error);
      return res.status(500).json({ error: "Failed to create session" });
    }

    const sessionId = data.id;
    console.log("✅ New session created:", sessionId);

    res.json({ sessionId });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({ error: "Failed to start interview" });
  }
});


// Analyze resume with Gemini AI
async function analyzeResumeWithGemini(resumeText) {
  const prompt = `
    Please analyze the following resume and provide a comprehensive evaluation in JSON format:

    Resume Text:
    ${resumeText}

    Please provide your analysis in the following JSON structure:
    {
      "overallScore": number (1-100),
      "summary": "Brief summary of the candidate",
      "strengths": ["strength1", "strength2", ...],
      "weaknesses": ["weakness1", "weakness2", ...],
      "skills": {
        "technical": ["skill1", "skill2", ...],
        "soft": ["skill1", "skill2", ...]
      },
      "experience": {
        "totalYears": number,
        "companies": ["company1", "company2", ...],
        "positions": ["position1", "position2", ...]
      },
      "education": {
        "degree": "highest degree",
        "institution": "institution name",
        "field": "field of study"
      },
      "recommendations": [
        {
          "category": "category name",
          "suggestion": "specific suggestion"
        }
      ],
      "keywordMatch": {
        "score": number (1-100),
        "missingKeywords": ["keyword1", "keyword2", ...]
      }
    }

    Make sure the response is valid JSON only, no additional text.
  `;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Clean the response and parse JSON
    const cleanedText = text.replace(/```json|```/g, '').trim();
    return JSON.parse(cleanedText);
  } catch (error) {
    console.error('Error analyzing resume:', error);
    throw error;
  }
}

// Get all responses for a specific session
app.get("/api/interview/session/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Get session details
    const { data: session, error: sessionError } = await supabase
      .from("interview_sessions")
      .select("*")
      .eq("id", sessionId)
      .single();

    if (sessionError) {
      console.error("❌ Session error:", sessionError);
      return res.status(404).json({ error: "Session not found" });
    }

    // Get all responses for this session
    const { data: responses, error: responsesError } = await supabase
      .from("interview_responses")
      .select("*")
      .eq("session_id", sessionId)
      .order("question_number", { ascending: true });

    if (responsesError) {
      console.error("❌ Responses error:", responsesError);
      return res.status(500).json({ error: "Failed to fetch responses" });
    }

    res.json({
      session,
      responses,
      totalQuestions: responses.length,
      totalMarks: session.total_marks,
      averageMarks: responses.length > 0 ? session.total_marks / responses.length : 0
    });

  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});
// GET /api/interview/responses/:sessionId
app.get('/api/interview/responses/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  
  try {
    const { data, error } = await supabase
      .from('interview_responses')
      .select('*')
      .eq('session_id', sessionId)
      .order('question_number', { ascending: true });
    
    if (error) throw error;
    
    res.json({ responses: data });
  } catch (error) {
    console.error('Error fetching responses:', error);
    res.status(500).json({ error: 'Failed to fetch responses' });
  }
});

// Get all sessions for a user
// Get all interview sessions (without join)
app.get("/api/interview/sessions", async (req, res) => {
  try {
    const { userId } = req.query;

    let query = supabase
      .from("interview_sessions")
      .select("*")
      .order("created_at", { ascending: false });

    if (userId) {
      query = query.eq("user_id", userId);
    }

    const { data: sessions, error } = await query;

    if (error) throw error;

    // Get response counts separately for each session
    const sessionsWithCounts = await Promise.all(
      sessions.map(async (session) => {
        const { count, error: countError } = await supabase
          .from("interview_responses")
          .select("*", { count: 'exact', head: true })
          .eq("session_id", session.id);

        return {
          ...session,
          response_count: count || 0
        };
      })
    );

    res.json({ sessions: sessionsWithCounts });
  } catch (error) {
    console.error("❌ Error fetching sessions:", error);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});
// Get all sessions with all their responses
app.get("/api/interview/all-sessions-detailed", async (req, res) => {
  try {
    const { data: sessions, error: sessionsError } = await supabase
      .from("interview_sessions")
      .select("*")
      .order("created_at", { ascending: false });

    if (sessionsError) throw sessionsError;

    // Get responses for each session
    const sessionsWithResponses = await Promise.all(
      sessions.map(async (session) => {
        const { data: responses, error: responsesError } = await supabase
          .from("interview_responses")
          .select("*")
          .eq("session_id", session.id)
          .order("question_number", { ascending: true });

        return {
          ...session,
          responses: responses || [],
          response_count: responses?.length || 0
        };
      })
    );

    res.json({ sessions: sessionsWithResponses });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});


app.post("/api/interview", async (req, res) => {
  try {
    const { userInput, questionContext, session, questionNumber, code } = req.body;

    if (!userInput || !session) {
      return res.status(400).json({ reply: "Missing user input or session ID." });
    }
    console.log(questionNumber);
    console.log(code);

    console.log("🔹 Gemini API called with:", { userInput, questionContext, questionNumber });

    const prompt = `
    You are an AI interviewer. 
    The candidate answered the question: "${questionContext}"
    with this response: "${userInput}"
    and code : "${code}".

    Evaluate the answer briefly and give:
    1. A score out of 10 (as a number only).
    2. A short constructive feedback (5-6 words only).

    Return your response in **strict JSON format** like this:
    {
      "feedback": "Good clarity but lacks depth",
      "marks": 7
    }`;

    const result = await model.generateContent(prompt);
    const rawText = result.response.text();

    console.log("✅ Raw Gemini output:", rawText);

    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
    } catch (err) {
      console.error("❌ JSON parse failed:", rawText);
      return res.status(500).json({ reply: "AI response not in valid format." });
    }

    const { feedback, marks } = parsed;

    if (marks === undefined || feedback === undefined) {
      return res.status(400).json({ reply: "AI output missing feedback or marks." });
    }

    // 🗄️ Insert individual response
    
    const { error: responseError } = await supabase
      .from("interview_responses")
      .insert({
        session_id: session,
        question_number: questionNumber || 1,
        question: questionContext,
        user_answer: userInput,
        feedback: feedback,
        marks: marks
      });

    if (responseError) {
      console.error("❌ Response insert error:", responseError);
      return res.status(500).json({ reply: "Error saving response to database." });
    }

    // 📊 Update total marks in session
    const { data: responses, error: fetchError } = await supabase
      .from("interview_responses")
      .select("marks")
      .eq("session_id", session);

    if (fetchError) {
      console.error("❌ Fetch error:", fetchError);
    } else {
      const totalMarks = responses.reduce((sum, r) => sum + (r.marks || 0), 0);
      
      await supabase
        .from("interview_sessions")
        .update({ 
          total_marks: totalMarks,
          updated_at: new Date().toISOString()
        })
        .eq("id", session);
    }

    console.log(`✅ Stored Q${questionNumber}: ${marks}/10 for session ${session}`);

    res.json({ reply: feedback, marks });
  } catch (error) {
    console.error("❌ Gemini route error:", error);
    res.status(500).json({ reply: "Error generating response from AI." });
  }
});

/*
app.post("/api/interview", async (req, res) => {
  try {
    const { userInput, questionContext, session } = req.body;

    if (!userInput || !session) {
      return res.status(400).json({ reply: "Missing user input or session ID." });
    }

    console.log(" Gemini API called with:", { userInput, questionContext });

    //  Updated prompt
    const prompt = `
    You are an AI interviewer. 
    The candidate answered the question: "${questionContext}"
    with this response: "${userInput}".

    Evaluate the answer briefly and give:
    1. A score out of 10 (as a number only).
    2. A short constructive feedback (5–6 words only).

    Return your response in **strict JSON format** like this:
    {
      "feedback": "Good clarity but lacks depth",
      "marks": 7
    }`;

    const result = await model.generateContent(prompt);
    const rawText = result.response.text();

    console.log(" Raw Gemini output:", rawText);

    //  Clean and parse the JSON from Gemini
    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
    } catch (err) {
      console.error(" JSON parse failed:", rawText);
      return res.status(500).json({ reply: "AI response not in valid format." });
    }

    const { feedback, marks } = parsed;

    if (marks === undefined || feedback === undefined) {
      return res.status(400).json({ reply: "AI output missing feedback or marks." });
    }

   /* // 🗄️ Store marks in Supabase table
    const { error: supabaseError } = await supabase
      .from("interview_sessions")
      .update({ marks })
      .eq("id", session);

    if (supabaseError) {
      console.error(" Supabase error:", supabaseError);
      return res.status(500).json({ reply: "Error saving marks to database." });
    }

    console.log(` Stored marks (${marks}/10) for session ${session}`);

    //  Send feedback + marks to frontend
    res.json({ reply: feedback, marks });
  } catch (error) {
    console.error(" Gemini route error:", error);
    res.status(500).json({ reply: "Error generating response from AI." });
  }
});*/

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Resume Analyzer API is running' });
});

app.post('/api/analyze-resume', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { userId, jobDescription } = req.body;
    const filePath = req.file.path;
    const mimeType = req.file.mimetype;

    // Extract text from the uploaded file
    const resumeText = await extractTextFromFile(filePath, mimeType);
    
    if (!resumeText || resumeText.trim().length === 0) {
      return res.status(400).json({ error: 'Could not extract text from the file' });
    }

    // Analyze resume with Gemini AI
    const analysis = await analyzeResumeWithGemini(resumeText);

    // Save to Supabase
    const { data, error } = await supabase
      .from('resume_analyses')
      .insert([
        {
          user_id: userId,
          filename: req.file.originalname,
          file_size: req.file.size,
          resume_text: resumeText,
          job_description: jobDescription || null,
          analysis: analysis,
          created_at: new Date().toISOString()
        }
      ])
      .select();

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: 'Database error' });
    }

    // Clean up uploaded file
    await fs.unlink(filePath);

    res.json({
      success: true,
      analysis: analysis,
      analysisId: data[0].id
    });

  } catch (error) {
    console.error('Error in analyze-resume:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message 
    });

    // Clean up file if it exists
    if (req.file && req.file.path) {
      try {
        await fs.unlink(req.file.path);
      } catch (cleanupError) {
        console.error('Error cleaning up file:', cleanupError);
      }
    }
  }
});

app.get('/api/analyses/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data, error } = await supabase
      .from('resume_analyses')
      .select('id, filename, analysis, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Database error' });
    }

    res.json({ analyses: data });
  } catch (error) {
    console.error('Error fetching analyses:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get specific analysis
app.get('/api/analysis/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('resume_analyses')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Analysis not found' });
    }

    res.json({ analysis: data });
  } catch (error) {
    console.error('Error fetching analysis:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/generate-interview-questions', async (req, res) => {
  try {
    const { userId, session_Id, skills } = req.body;
    console.log(req.body)
    if (!userId || !skills || !session_Id) {
      return res.status(400).json({ error: 'User ID, session_Id and skills are required' });
    }
    const technicalSkills = skills.technical || [];
    const softSkills = skills.soft || [];

    const prompt = `
      Generate comprehensive interview questions based on these skills:

      Technical Skills: ${technicalSkills.join(', ')}
      Soft Skills: ${softSkills.join(', ')}

      Please provide interview questions in the following JSON format:
      [
        {
          "category": "Technical Questions",
          "questions": [
            {
              "question": "specific technical question",
              "tip": "brief tip for answering",
              "skills": ["relevant skill 1", "relevant skill 2"]
            }
          ]
        },
        {
          "category": "Behavioral Questions", 
          "questions": [
            {
              "question": "behavioral question about soft skills",
              "tip": "brief tip for answering",
              "skills": ["relevant soft skill"]
            }
          ]
        },
        {
          "category": "Situational Questions",
          "questions": [
            {
              "question": "scenario-based question",
              "tip": "brief tip for answering",
              "skills": ["relevant skill"]
            }
          ]
        }
      ]

      Generate 6 Technical Questions were 2 DSA Questions
      , 2 questions from Behavioral Questions and 2 Situational Questions. Make questions specific to the provided skills.
      Return only valid JSON. 
    `;

    console.log('Generating interview questions...');
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    
    let cleanedText = text.replace(/```json|```/g, '').trim();
    
    // Find JSON array boundaries
    const firstBracket = cleanedText.indexOf('[');
    const lastBracket = cleanedText.lastIndexOf(']');
    
    if (firstBracket !== -1 && lastBracket !== -1) {
      cleanedText = cleanedText.substring(firstBracket, lastBracket + 1);
    }
    
    const questions = JSON.parse(cleanedText);

  
    const { data, error: dbError } = await supabase
    .from('interview_sessions')
    .update({
      user_id: userId,
      selected_skills: skills,
      questions: questions,
      updated_at: new Date().toISOString()
    })
    .eq("id", session_Id)  // Find the session with this ID
    .select()
    .single();
  
  if (dbError) {
    console.error('Error updating interview session:', dbError);
    return res.status(500).json({ error: "Failed to update session" });
  }
  
  console.log('✅ Session updated:', data);

    console.log('Interview questions generated successfully');
    res.json({ 
      success: true, 
      questions: questions,
      totalQuestions: questions.reduce((sum, category) => sum + category.questions.length, 0)
    });
    console.log(questions)

  } catch (error) {
    console.error('Error generating interview questions:', error);
    res.status(500).json({ 
      error: 'Failed to generate interview questions', 
      details: error.message 
    });
  }
});

app.post('/api/save-interview', async (req, res) => {
  try {
    const { userId, questions, responses, duration, completedAt, chatHistory } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const { data, error } = await supabase
      .from('interview_sessions')
      .insert([
        {
          user_id: userId,
          questions: questions,
          responses: responses,
          duration: duration,
          completed_at: completedAt,
          chat_history: chatHistory,
          created_at: new Date().toISOString()
        }
      ])
      .select();

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: 'Database error: ' + error.message });
    }

    res.json({
      success: true,
      interviewId: data[0].id,
      message: 'Interview saved successfully'
    });

  } catch (error) {
    console.error('Error saving interview:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message 
    });
  }
});

// Get user's interview history
app.get('/api/interviews/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data, error } = await supabase
      .from('interview_sessions')
      .select('*')
      .eq('user_id', userId)
      .order('completed_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Database error: ' + error.message });
    }

    res.json({ interviews: data });
  } catch (error) {
    console.error('Error fetching interview history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/fetch-qustions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('interview_sessions')
      .select('*')
      .eq('id', id)
    if (error || !data) {
      return res.status(404).json({ error: 'not found' });
    }

    res.json({ analysis: data });
  } catch (error) {
    console.error('Error fetching questions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});









// Start server
app.listen(PORT, () => {
  console.log(`Resume Analyzer API running on port ${PORT}`);
});

