import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import cors from 'cors';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const genAI = new GoogleGenerativeAI(process.env.VITE_GEMINI_API_KEY );
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Simplified in-memory storage - only what's needed
const userSessions = new Map();
const conversationHistory = new Map();

// Middleware
const allowedOrigins = [
  'https://alan-three.vercel.app'
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());

// Helper function to generate user session ID
function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Helper function to get user mood/sentiment
function analyzeSentiment(message) {
  const positiveWords = ['good', 'great', 'amazing', 'wonderful', 'excellent', 'love', 'like', 'happy', 'excited', 'awesome', 'fantastic', 'perfect', 'thanks', 'thank you'];
  const negativeWords = ['bad', 'terrible', 'awful', 'hate', 'dislike', 'sad', 'angry', 'frustrated', 'disappointed', 'horrible', 'worst', 'annoying', 'upset'];
  
  const words = message.toLowerCase().split(/\s+/);
  let score = 0;
  
  words.forEach(word => {
    if (positiveWords.includes(word)) score += 1;
    if (negativeWords.includes(word)) score -= 1;
  });
  
  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

// Intent detection function
function detectIntent(message) {
  const lowerMessage = message.toLowerCase();
  
  if (/\b(hello|hi|hey|good morning|good afternoon|good evening|greetings)\b/i.test(lowerMessage)) {
    return 'greeting';
  }
  if (/\b(cost|price|fee|charge|payment|money|expensive|cheap|pricing)\b/i.test(lowerMessage)) {
    return 'pricing';
  }
  if (/\b(how long|duration|time|weeks|months|session length|program length)\b/i.test(lowerMessage)) {
    return 'duration';
  }
  if (/\b(book|schedule|appointment|session|consultation|meet|booking)\b/i.test(lowerMessage)) {
    return 'booking';
  }
  if (/\b(background|experience|qualification|credentials|about you|who are you)\b/i.test(lowerMessage)) {
    return 'background';
  }
  if (/\b(qualify|qualification|how do you|what makes you|certified)\b/i.test(lowerMessage)) {
    return 'qualification';
  }
  
  return 'general';
}

// Static system prompt
const BASE_PROMPT = `You are SpeskOn, an advanced AI assistant representing our coaching team with one specialized coach:

**ALAN - Performance Coach** 🎯
- Specializes in performance coaching, self-leadership, and personal growth
- Background: Expert in helping individuals build stronger relationships with themselves
- Focus: Compassion, clarity, courage, and aligning actions with values
- Approach: Blends performance with zest for life, emphasizes mental health and life balance

PERSONALITY TRAITS:
- Warm, empathetic, and intuitive
- Professional yet approachable
- Wise with a touch of humor
- Genuinely caring about people's growth
- Uses modern, conversational language while maintaining professionalism

RESPONSE RULES:

**PERFORMANCE COACHING (Alan):**
1. **Pricing Questions**: "$750 CAD/month with 3-4 sessions monthly for at least 6 months - an investment in your transformation and sustainable growth."
2. **Duration Questions**: "Minimum 6 months with 3-4 sessions per month to build lasting habits and achieve real transformation."
3. **Background Questions**: "Alan focuses on self-leadership and helping you build a stronger relationship with yourself. His approach blends performance with zest for life, emphasizing mental health, clarity, and courage."

**BOOKING/SCHEDULING**: Guide them to provide their name and email address, and mention our easy booking system. Ask which coach they're interested in working with.

**SERVICE DETERMINATION**: 
- If they mention performance, goals, leadership, confidence, stress management → Alan
- If unclear, ask which type of coaching interests them more

STYLE GUIDELINES:
- Use their name when provided
- Include relevant emojis sparingly (1-2 per response)
- Reference previous conversations when relevant
- Offer personalized insights based on their interests
- If mood is negative, offer extra empathy and support
- If mood is positive, match their energy with enthusiasm
- Keep responses conversational and under 150 words
- Always sign with "- SpeskOn (representing Alan) 🌟"
- Add value with each response - whether it's a tip, insight, or encouragement`;

// CORE API: Main chat endpoint
app.post('/api/chat', async (req, res) => {
  const start = Date.now();
  
  try {
    const { message, sessionId = generateSessionId(), userName } = req.body;

    if (!message || message.trim() === '') {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Get or create user session
    let userSession = userSessions.get(sessionId);
    if (!userSession) {
      userSession = {
        id: sessionId,
        userName: userName || 'Friend',
        conversationCount: 0,
        mood: 'neutral',
        interests: [],
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString()
      };
      userSessions.set(sessionId, userSession);
      conversationHistory.set(sessionId, []);
    }

    // Update session metadata
    userSession.conversationCount += 1;
    userSession.lastActivity = new Date().toISOString();

    // Extract name if user says "My name is [name]"
    const nameMatch = message.match(/my name is (\w+)/i);
    if (nameMatch) {
      userSession.userName = nameMatch[1];
      return res.status(200).json({
        response: `Hi ${userSession.userName}! How can I assist you today?`,
        sessionId,
        mood: userSession.mood,
      });
    }

    // Analyze message
    const sentiment = analyzeSentiment(message);
    const intent = detectIntent(message);
    userSession.mood = sentiment;

    // Update conversation history
    const history = conversationHistory.get(sessionId) || [];
    history.push({ 
      type: 'user', 
      message: message.trim(), 
      timestamp: new Date().toISOString() 
    });

    // Keep only last 30 messages for better performance (increased from 10)
    if (history.length > 30) {
      history.splice(0, history.length - 30);
    }

    // Create context from recent messages (increased from 4 to 15)
    const contextMessages = history.slice(-15)
      .map(h => `${h.type === 'user' ? 'User' : 'SpeskOn'}: ${h.message}`)
      .join('\n');

    // Build dynamic prompt
    const dynamicPrompt = `
USER CONTEXT:
- Session ID: ${sessionId}
- User Name: ${userSession.userName}
- Conversation Count: ${userSession.conversationCount}
- Current Mood: ${sentiment}
- Detected Intent: ${intent}
- Previous conversation context: ${contextMessages}

CURRENT MESSAGE: "${message}"

Please respond according to the personality traits and response rules above.`;

    const finalPrompt = `${BASE_PROMPT}\n\n${dynamicPrompt}`;

    // Generate response from Gemini
    const result = await model.generateContent(finalPrompt);
    
    if (!result || !result.response) {
      throw new Error('Invalid response from AI model');
    }

    const responseText = result.response.text().trim();

    // Save assistant response to history
    history.push({ 
      type: 'assistant', 
      message: responseText, 
      timestamp: new Date().toISOString() 
    });
    conversationHistory.set(sessionId, history);

    // Update user interests
    updateUserInterests(userSession, intent, message);

    // Send response
    res.status(200).json({
      response: responseText,
      sessionId: sessionId,
      mood: sentiment,
      intent: intent,
      processingTime: Date.now() - start
    });

    console.log(`[Chat] Session ${sessionId} responded in ${Date.now() - start}ms`);
    
  } catch (error) {
    console.error('Error handling chat:', error);
    res.status(500).json({ 
      error: 'Failed to generate response',
      details: error.message 
    });
  }
});

// Helper function to update user interests
function updateUserInterests(userSession, intent, message) {
  const interests = userSession.interests || [];
  const lowerMessage = message.toLowerCase();
  
  // Add interests based on intent and message content
  if (intent === 'booking' && !interests.includes('booking')) {
    interests.push('booking');
  }
  if (intent === 'pricing' && !interests.includes('pricing')) {
    interests.push('pricing');
  }
  if (lowerMessage.includes('performance') && !interests.includes('performance')) {
    interests.push('performance');
  }
  if (lowerMessage.includes('leadership') && !interests.includes('leadership')) {
    interests.push('leadership');
  }
  
  userSession.interests = interests;
}

// Email setup for booking meetings
const transporter = nodemailer.createTransport({
  service: 'gmail',
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER || 'appointmentstudio1@gmail.com',
    pass: process.env.EMAIL_PASS || 'your-app-password',
  },
  tls: {
    rejectUnauthorized: false,
  },
  connectionTimeout: 60000,
  greetingTimeout: 30000,
  socketTimeout: 60000,
});

// CORE API: Booking endpoint
app.post('/api/book-meeting', async (req, res) => {
  try {
    const { name, email, sessionId, message, coachType = 'performance' } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    // Get user session for personalized booking
    const userSession = userSessions.get(sessionId);
    const schedulingUrl = `https://calendly.com/alan-performance/30min/${Math.random().toString(36).substring(7)}`;

    // Update user session with booking info
    if (userSession) {
      userSession.hasBooked = true;
      userSession.bookingDetails = { 
        name, 
        email, 
        coachType,
        timestamp: new Date().toISOString() 
      };
    }

    // Coach and service details
    const coachName = 'Alan';
    const serviceType = 'Performance Coaching';
    const serviceDetails = 'Performance Coaching with Alan ($750 CAD/month, 6-month commitment)';

    const personalizedMessage = userSession ? 
      `Based on our chat, ${userSession.userName}, you're interested in ${serviceType}.` : 
      `Thank you for your interest in ${serviceType}.`;

    const mailOptions = {
      from: process.env.EMAIL_USER || 'alan.verbeke@me.com',
      to: 'alan.verbeke@me.com',  // Update to your contact email
      subject: `New Booking Request - ${coachName} - ${name}`,
      text: `
New booking request details:

Name: ${name}
Email: ${email}
Coach: ${coachName}
Service: ${serviceType}

Message from user:
${message || 'No additional message'}

${personalizedMessage}

Booking link: ${schedulingUrl}

Best regards,
SpeskOn AI
      `
    };

    await transporter.sendMail(mailOptions);

    res.status(200).json({
      message: `Booking request sent successfully. You can also book directly here: ${schedulingUrl}`,
      schedulingUrl
    });

    console.log(`[Booking] Booking request email sent for ${name} to ${coachName}`);

  } catch (error) {
    console.error('Error processing booking:', error);
    res.status(500).json({ error: 'Failed to send booking request', details: error.message });
  }
});
// New Contact Form Endpoint
app.post('/api/contact', async (req, res) => {
  const { name, email, message } = req.body;

  // Input validation
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required.' });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  try {
    // Prepare email content with HTML formatting
    const mailOptions = {
      from: 'alan.verbeke@me.com',
      to: 'alan.verbeke@me.com',
      subject: `New Contact Form Submission from ${name}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <h2 style="color: #2c3e50;">New Contact Form Submission</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Message:</strong></p>
          <div style="background-color: #f4f4f4; padding: 10px; border-radius: 5px; margin-top: 10px;">
            ${message}
          </div>
          <p style="font-size: 0.9em; color: #7f8c8d; margin-top: 20px;">
            Sent via SpeskOn Contact Form
          </p>
        </div>
      `
    };

    // Send the email to the admin
    await transporter.sendMail(mailOptions);

    // Optionally, send a confirmation email to the user
    const confirmationMailOptions = {
      from: 'alan.verbeke@me.com',
      to: email,
      subject: 'Thank you for contacting us!',
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <h2 style="color: #2c3e50;">Thank you for reaching out, ${name}!</h2>
          <p>We have received your message and will get back to you as soon as possible.</p>
          <p><strong>Your Message:</strong></p>
          <div style="background-color: #f4f4f4; padding: 10px; border-radius: 5px; margin-top: 10px;">
            ${message}
          </div>
          <p style="font-size: 0.9em; color: #7f8c8d; margin-top: 20px;">
            If you need immediate assistance, please contact us at <strong>appointmentstudio1@gmail.com</strong>.
          </p>
        </div>
      `
    };

    await transporter.sendMail(confirmationMailOptions);

    // Send response to the user
    res.status(200).json({ message: 'Your message has been sent successfully!' });
    console.log(`[Contact] Message received from ${name} <${email}>`);
    
  } catch (error) {
    console.error('Error sending contact message:', error);
    
    // Handle errors more explicitly
    res.status(500).json({
      error: 'Failed to send message. Please try again later.',
      details: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`SpeskOn Performance Coach backend running on port ${PORT}`);
});
