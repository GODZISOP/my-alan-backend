import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import cors from 'cors';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const genAI = new GoogleGenerativeAI(process.env.VITE_GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Simplified in-memory storage - only what's needed
const userSessions = new Map();
const conversationHistory = new Map();

// FAQ Database - Fast responses for common questions
const FAQ_DATABASE = {
  performance_coaching: {
    keywords: ['performance coaching', 'coaching different', 'what makes', 'different coaching', 'performance coach'],
    answer: "My coaching goes beyond goals and metrics—it's deeply personal. I help you build a stronger relationship with yourself first. True performance starts with self-leadership: compassion, clarity, and courage. From there, we align your actions with your values and create sustainable growth."
  },
  leading_yourself: {
    keywords: ['leading yourself', 'self leadership', 'lead yourself', 'self-leadership', 'what does leading'],
    answer: "Leading yourself means learning to trust your decisions, understand your inner dialogue, and take action that's aligned with who you really are. It's not about pushing harder—it's about being clear, grounded, and resilient."
  },
  pushing_achieve: {
    keywords: ['pushing to achieve', 'just about pushing', 'achieve more', 'performance pushing'],
    answer: "Not at all. While achievement matters, my approach blends performance with zest for life. I help you reconnect with the spark—the joy and energy that make your efforts meaningful. You don't just perform; you thrive."
  },
  mental_health: {
    keywords: ['mental health', 'wellbeing', 'well-being', 'mental clarity', 'burnout'],
    answer: "It's foundational. Success shouldn't come at the cost of your well-being. My coaching supports life balance and mental clarity, so your growth feels aligned, not overwhelming. Burnout isn't an option—we build from a place of wholeness."
  },
  coaching_program: {
    keywords: ['coaching program', 'program include', 'what does program', 'program includes'],
    answer: "The program includes:\n• Custom coaching plans\n• Weekly or bi-weekly sessions\n• Validated assessments\n• Actionable feedback\n• Skills for long-term success\n\nEach part is tailored to your goals, mindset, and lifestyle."
  },
  results_expect: {
    keywords: ['results expect', 'what results', 'expect from coaching', 'outcomes'],
    answer: "Clients often experience:\n• Goal clarity\n• Improved confidence\n• Better time management\n• Stronger communication\n• Reduced stress\n\nBut most importantly, they feel more aligned, energized, and in control of their journey."
  },
  cost_commitment: {
    keywords: ['cost', 'commitment', 'price', 'how much', 'pricing', 'fee'],
    answer: "It's $750 CAD/month. We meet 3–4 times per month for at least 6 months, giving you time to build lasting habits and achieve real transformation."
  },
  // Spiritual coaching questions (existing)
  spiritual_pricing: {
    keywords: ['spiritual cost', 'spiritual price', 'spiritual session cost'],
    answer: "$100 USD per session - an investment in your spiritual journey and personal transformation."
  },
  spiritual_duration: {
    keywords: ['spiritual duration', 'spiritual time', 'spiritual weeks', 'spiritual commitment'],
    answer: "I require 6 weeks of weekly one-hour session commitment. After that time, we can assess your progress and adjust any additional sessions according to your needs and desired outcomes."
  }
};

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

// FAQ Matching function - Fast response system
function findFAQMatch(message) {
  const lowerMessage = message.toLowerCase();
  
  for (const [key, faq] of Object.entries(FAQ_DATABASE)) {
    for (const keyword of faq.keywords) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        return {
          matched: true,
          answer: faq.answer,
          type: 'faq',
          category: key
        };
      }
    }
  }
  
  return { matched: false };
}

// Intent detection function (enhanced)
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
  if (/\b(performance|coaching|leading yourself|mental health|results)\b/i.test(lowerMessage)) {
    return 'performance_coaching';
  }
  
  return 'general';
}

// Static system prompt (enhanced)
const BASE_PROMPT = `You are SpeskOn, an advanced AI assistant representing Chris, who offers both spiritual coaching and performance coaching services.

PERSONALITY TRAITS:
- Warm, empathetic, and spiritually intuitive
- Professional yet approachable
- Wise with a touch of humor
- Genuinely caring about people's growth
- Uses modern, conversational language while maintaining professionalism

SERVICES OFFERED:
1. **Spiritual Coaching**: $100 USD per session, 6-week commitment
2. **Performance Coaching**: $750 CAD/month, 3-4 sessions monthly, 6-month minimum

RESPONSE RULES:

1. **Spiritual Pricing**: "$100 USD per session - an investment in your spiritual journey and personal transformation."

2. **Performance Pricing**: "$750 CAD/month with 3-4 sessions monthly for at least 6 months."

3. **Duration Questions**: 
   - Spiritual: "6 weeks of weekly one-hour sessions, then assess progress."
   - Performance: "Minimum 6 months with 3-4 sessions per month for lasting transformation."

4. **Background Questions**: "I began my journey at age 12 studying under a Japanese Shaman the arts of acupressure. Later, I became fascinated by and studied the art of biofeedback. I expanded my studies into Christ Centered Metaphysics and the arts of energetic healing. I also specialize in performance coaching, helping clients build self-leadership and sustainable growth."

5. **Booking/Scheduling**: Guide them to provide their name and email address for our booking system.

STYLE GUIDELINES:
- Use their name when provided
- Include relevant emojis sparingly (1-2 per response)
- Keep responses conversational and under 150 words
- Always sign with "- SpeskOn (on behalf of Chris) ✨"
- Match their energy level appropriately`;

// CORE API: Main chat endpoint (enhanced with FAQ)
app.post('/api/chat', async (req, res) => {
  const start = Date.now();
  
  try {
    const { message, sessionId = generateSessionId(), userName } = req.body;

    if (!message || message.trim() === '') {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Check FAQ first for instant responses
    const faqMatch = findFAQMatch(message);
    
    if (faqMatch.matched) {
      // Fast FAQ response
      const response = `${faqMatch.answer}\n\nWould you like to know more about this or book a session? 😊\n\n- SpeskOn (on behalf of Chris) ✨`;
      
      return res.status(200).json({
        response: response,
        sessionId: sessionId,
        mood: analyzeSentiment(message),
        intent: 'faq',
        responseType: 'faq',
        category: faqMatch.category,
        processingTime: Date.now() - start
      });
    }

    // Get or create user session for AI responses
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

    // Keep only last 30 messages for better performance
    if (history.length > 30) {
      history.splice(0, history.length - 30);
    }

    // Create context from recent messages
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
      responseType: 'ai',
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
  if (intent === 'performance_coaching' && !interests.includes('performance_coaching')) {
    interests.push('performance_coaching');
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
  if (lowerMessage.includes('performance') && !interests.includes('performance')) {
    interests.push('performance');
  }
  
  userSession.interests = interests;
}

// Email setup for booking meetings
const transporter = nodemailer.createTransporter({
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
    const { name, email, sessionId, message, serviceType = 'spiritual' } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    // Get user session for personalized booking
    const userSession = userSessions.get(sessionId);
    const schedulingUrl = `https://calendly.com/chris-lightworks/30min/${Math.random().toString(36).substring(7)}`;

    // Update user session with booking info
    if (userSession) {
      userSession.hasBooked = true;
      userSession.bookingDetails = { 
        name, 
        email, 
        serviceType,
        timestamp: new Date().toISOString() 
      };
    }

    // Determine service details
    const serviceDetails = serviceType === 'performance' 
      ? 'Performance Coaching ($750 CAD/month, 6-month commitment)'
      : 'Spiritual Coaching ($100 USD/session, 6-week commitment)';

    const personalizedMessage = userSession ? 
      `Based on our conversation, I believe Chris's ${serviceType} coaching approach will be perfect for your journey.` :
      `Thank you for your interest in Chris's ${serviceType} coaching program!`;

    const clientEmailOptions = {
      from: `"Chris Spiritual & Performance Coaching" <appointmentstudio1@gmail.com>`,
      to: email,
      subject: '🌟 Your Transformation Journey Awaits - Booking Confirmation',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 15px;">
          <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.1);">
            <h2 style="color: #4A90E2; text-align: center; margin-bottom: 20px;">✨ Your Transformation Journey Begins Here ✨</h2>
            <p style="font-size: 16px; color: #333;">Dear ${name},</p>
            <p style="font-size: 16px; color: #333; line-height: 1.6;">${personalizedMessage}</p>
            <p style="font-size: 14px; color: #666; margin: 15px 0;"><strong>Service:</strong> ${serviceDetails}</p>
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
      from: `"Chris Spiritual & Performance Coaching" <appointmentstudio1@gmail.com>`,
      to: 'appointmentstudio1@gmail.com',
      subject: '🎯 New Qualified Lead - Meeting Booking Request',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8f9fa; padding: 20px; border-radius: 10px;">
          <h2 style="color: #2c3e50; text-align: center;">🎯 New Qualified Lead</h2>
          <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <p><strong>👤 Name:</strong> ${name}</p>
            <p><strong>📧 Email:</strong> ${email}</p>
            <p><strong>🎯 Service Interest:</strong> ${serviceDetails}</p>
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
        serviceType,
        personalized: !!userSession
      });
    } catch (emailError) {
      console.error('Email sending failed:', emailError);
      res.json({
        message: 'Meeting booking link generated successfully! Please use the link below to complete your booking.',
        schedulingUrl,
        serviceType,
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
      from: `"Chris Spiritual & Performance Coaching" <appointmentstudio1@gmail.com>`,
      to: 'appointmentstudio1@gmail.com',
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
      from: `"Chris Spiritual & Performance Coaching" <appointmentstudio1@gmail.com>`,
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

// API to get FAQ categories (optional - for frontend reference)
app.get('/api/faq-categories', (req, res) => {
  const categories = Object.keys(FAQ_DATABASE).map(key => ({
    key,
    keywords: FAQ_DATABASE[key].keywords
  }));
  
  res.json({ categories, totalFAQs: Object.keys(FAQ_DATABASE).length });
});

// Start server
app.get('/', (req, res) => {
  res.send('✅ SpeskOn Backend with Enhanced FAQ System is running!');
});

app.listen(PORT, () => {
  console.log(`🚀 SpeskOn AI Assistant running on port ${PORT}`);
  console.log(`🌟 Enhanced with instant FAQ responses + AI chatbot`);
  console.log(`📚 FAQ Database loaded with ${Object.keys(FAQ_DATABASE).length} categories`);
});