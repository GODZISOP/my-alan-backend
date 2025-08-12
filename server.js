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
  'http://localhost:5173',
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
const BASE_PROMPT = `You are SpeskOn, an advanced AI assistant representing Chris, a professional spiritual coach and healer.

PERSONALITY TRAITS:
- Warm, empathetic, and spiritually intuitive
- Professional yet approachable
- Wise with a touch of humor
- Genuinely caring about people's growt
- Uses modern, conversational language while maintaining professionalism

RESPONSE RULES:

1. **Pricing Questions**: "$100 USD per session - an investment in your spiritual journey and personal transformation."

2. **Duration Questions**: "I require 6 weeks of weekly one-hour session commitment. After that time, we can assess your progress and adjust any additional sessions according to your needs and desired outcomes."

3. **Background Questions**: "I began my journey at age 12 studying unde a Japanese Shaman the arts of acupressure. Later, I became fascinated by and studied the art of biofeedback. I expanded my studies into Christ Centered Metaphysics and the arts of energetic healing. Throughout the years, I enhanced my studies with understanding various faith traditions and guiding patrons along their spiritual journeys."

4. **Booking/Scheduling**: Guide them to provide their name and email address, and mention our easy booking system.

5. **Qualification Questions**: "Great question! First, we identify your ideal coaching client. Then, our team contacts prospects through platforms like Facebook, LinkedIn, and Gmail, introducing your offer. Only those who show real interest and align with your services are booked. That means your appointments are with warm, pre-qualified leads who already understand your value."

6. **First-time visitors**: Welcome them warmly and explain the benefits of spiritual coaching.

7. **Returning visitors**: Acknowledge their return and build onn previous conversations.

STYLE GUIDELINES:
- Use their name when provided
- Include relevant emojis sparingly (1-2 per response)
- Reference previous conversations when relevant
- Offer personalized insights based on their interests
- If mood is negative, offer extra empathy and support
- If mood is positive, match their energy with enthusiasm
- Keep responses conversational and under 150 words
- Always sign with "- SpeskOn (on behalf of Chris) ✨"
- Add value with each response - whether it's a tip, insight, or encouragement`;

// CORE API: Main chat endpoint
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
  if (lowerMessage.includes('spiritual') && !interests.includes('spiritual')) {
    interests.push('spiritual');
  }
  if (lowerMessage.includes('healing') && !interests.includes('healing')) {
    interests.push('healing');
  }
  if (lowerMessage.includes('meditation') && !interests.includes('meditation')) {
    interests.push('meditation');
  }
  if (lowerMessage.includes('energy') && !interests.includes('energy')) {
    interests.push('energy');
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
    const { name, email, sessionId, message } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    // Get user session for personalized booking
    const userSession = userSessions.get(sessionId);
    const schedulingUrl = `https://calendly.com/chris-lightworks/30min/${Math.random().toString(36).substring(7)}`;

    // Update user session with booking info
    if (userSession) {
      userSession.hasBooked = true;
      userSession.bookingDetails = { name, email, timestamp: new Date().toISOString() };
    }

    // Simplified email sending - removed verification step for speed
    const personalizedMessage = userSession ? 
      `Based on our conversation, I believe Chris's spiritual coaching approach will be perfect for your journey.` :
      `Thank you for your interest in Chris's coaching program!`;

    const clientEmailOptions = {
      from: `"Chris Spiritual Coaching" <appointmentstudio1@gmail.com>`,
      to: email,
      subject: '🌟 Your Spiritual Journey Awaits - Booking Confirmation',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 15px;">
          <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.1);">
            <h2 style="color: #4A90E2; text-align: center; margin-bottom: 20px;">✨ Your Spiritual Journey Begins Here ✨</h2>
            <p style="font-size: 16px; color: #333;">Dear ${name},</p>
            <p style="font-size: 16px; color: #333; line-height: 1.6;">${personalizedMessage}</p>
            <p style="font-size: 16px; color: #333; line-height: 1.6;">Complete your booking by clicking the button below:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${schedulingUrl}" style="background: linear-gradient(45deg, #4A90E2, #50E3C2); color: white; padding: 15px 30px; text-decoration: none; border-radius: 50px; font-weight: bold; font-size: 16px; display: inline-block; box-shadow: 0 5px 15px rgba(0,0,0,0.2);">🗓️ Complete Your Booking</a>
            </div>
            <p style="font-size: 14px; color: #666; text-align: center; margin-top: 20px;">
              Questions? Reply to this email or reach out anytime.<br>
              <em>- SpeskOn (on behalf of Chris) ✨</em>
            </p>
          </div>
        </div>
      `,
    };

    const businessEmailOptions = {
      from: `"Chris Spiritual Coaching" <appointmentstudio1@gmail.com>`,
      to: 'crosenwirth@gmail.com',
      subject: '🎯 New Qualified Lead - Meeting Booking Request',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8f9fa; padding: 20px; border-radius: 10px;">
          <h2 style="color: #2c3e50; text-align: center;">🎯 New Qualified Lead</h2>
          <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <p><strong>👤 Name:</strong> ${name}</p>
            <p><strong>📧 Email:</strong> ${email}</p>
            <p><strong>🔗 Booking Link:</strong> <a href="${schedulingUrl}" style="color: #3498db;">${schedulingUrl}</a></p>
            ${message ? `<p><strong>💭 Additional Message:</strong> ${message}</p>` : ''}
          </div>
        </div>
      `,
    };

    try {
      await Promise.all([
        transporter.sendMail(clientEmailOptions),
        transporter.sendMail(businessEmailOptions),
      ]);

      res.json({
        message: 'Meeting booking initiated successfully! Check your email for the booking link.',
        schedulingUrl,
        personalized: !!userSession
      });
    } catch (emailError) {
      console.error('Email sending failed:', emailError);
      res.json({
        message: 'Meeting booking link generated successfully! Please use the link below to complete your booking.',
        schedulingUrl,
        note: 'Email notification failed, but your booking link is ready.',
      });
    }
  } catch (error) {
    console.error('Error booking meeting:', error);
    res.status(500).json({ error: 'Failed to book meeting. Please try again.' });
  }
});

// CORE API: Contact form
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }

    const businessEmailOptions = {
      from: `"Chris Spiritual Coaching" <appointmentstudio1@gmail.com>`,
      to: 'crosenwirth@gmail.com',
      subject: '📧 New Contact Form Submission',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8f9fa; padding: 20px; border-radius: 10px;">
          <h2 style="color: #2c3e50; text-align: center; margin-bottom: 30px;">📧 New Contact Form Submission</h2>
          <div style="background: white; padding: 25px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <p><strong>👤 Name:</strong> ${name}</p>
            <p><strong>📧 Email:</strong> ${email}</p>
            <p><strong>⏰ Received:</strong> ${new Date().toLocaleString()}</p>
            <h3 style="color: #4A90E2; margin-top: 30px;">💬 Message:</h3>
            <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; border-left: 4px solid #4A90E2;">
              ${message.replace(/\n/g, '<br>')}
            </div>
          </div>
        </div>
      `,
    };

    const clientEmailOptions = {
      from: `"Chris Spiritual Coaching" <appointmentstudio1@gmail.com>`,
      to: email,
      subject: '🌟 Thank you for reaching out - We received your message!',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 15px;">
          <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.1);">
            <h2 style="color: #4A90E2; text-align: center; margin-bottom: 20px;">🌟 Thank You for Connecting!</h2>
            <p style="font-size: 16px; color: #333;">Dear ${name},</p>
            <p style="font-size: 16px; color: #333; line-height: 1.6;">
              Thank you for reaching out! I've received your message and will respond within 24 hours.
            </p>
            <p style="font-size: 16px; color: #4A90E2; font-weight: bold; text-align: center; margin-top: 20px;">
              - Chris ✨
            </p>
          </div>
        </div>
      `,
    };

    await Promise.all([
      transporter.sendMail(businessEmailOptions),
      transporter.sendMail(clientEmailOptions),
    ]);

    return res.status(200).json({
      message: 'Message sent successfully! You will receive a confirmation email shortly.',
      success: true
    });

  } catch (error) {
    console.error('Contact Form Error:', error);
    return res.status(500).json({
      error: 'Internal server error. Please try again later.',
    });
  }
});

// Start server
app.get('/', (req, res) => {
  res.send('✅ SpeskOn Backend is running!');
});
app.listen(PORT, () => {
  console.log(`🚀 SpeskOn AI Assistant running on port ${PORT}`);
  console.log(`🌟 Optimized for speed and stability`);
});