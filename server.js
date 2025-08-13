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
      from: process.env.EMAIL_USER || 'appointmentstudio1@gmail.com',
      to: 'alan@example.com',  // Update to your contact email
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
app.post('/api/contact', contactLimiter, async (req, res) => {
  const start = Date.now();
  
  try {
    let { name, email, message, phone, subject, preferredContact } = req.body;

    // Enhanced validation
    name = sanitizeInput(name, 100);
    email = sanitizeInput(email, 254);
    message = sanitizeInput(message, 2000);
    phone = sanitizeInput(phone, 20);
    subject = sanitizeInput(subject, 200) || 'New Contact Form Submission';
    preferredContact = sanitizeInput(preferredContact, 20) || 'email';

    const validationErrors = [];
    
    if (!name || name.length < 2) {
      validationErrors.push('Please provide your full name (at least 2 characters)');
    }
    
    if (!email || !validateEmail(email)) {
      validationErrors.push('Please provide a valid email address');
    }
    
    if (!message || message.length < 10) {
      validationErrors.push('Please provide a detailed message (at least 10 characters)');
    }
    
    if (phone && !/^[\+]?[\d\s\-\(\)]{10,}$/.test(phone)) {
      validationErrors.push('Please provide a valid phone number');
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({ 
        error: 'Please correct the following issues:',
        validationErrors,
        code: 'VALIDATION_ERROR'
      });
    }

    // Check for duplicate submissions
    const submissionKey = `${email}_${Date.now() - (5 * 60 * 1000)}`; // 5 minute window
    const existingSubmissions = Array.from(contactSubmissions.keys())
      .filter(key => key.startsWith(email) && (Date.now() - parseInt(key.split('_')[1])) < 300000);
    
    if (existingSubmissions.length > 0) {
      return res.status(429).json({ 
        error: 'You recently submitted a message. Please wait 5 minutes before submitting again.',
        code: 'DUPLICATE_SUBMISSION'
      });
    }

    // Store submission
    contactSubmissions.set(`${email}_${Date.now()}`, {
      name, email, message, phone, subject, preferredContact,
      timestamp: new Date().toISOString(),
      ip: req.ip
    });

    // Clean old submissions (older than 1 hour)
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    for (const [key] of contactSubmissions) {
      const timestamp = parseInt(key.split('_')[1]);
      if (timestamp < oneHourAgo) {
        contactSubmissions.delete(key);
      }
    }

    // Enhanced email content
    const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #2563eb; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">
        🌟 New Contact Form Submission - Alan Performance Coaching
      </h2>
      
      <div style="background-color: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h3 style="color: #374151; margin-top: 0;">Contact Details</h3>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
        ${phone ? `<p><strong>Phone:</strong> ${phone}</p>` : ''}
        <p><strong>Preferred Contact:</strong> ${preferredContact}</p>
        <p><strong>Subject:</strong> ${subject}</p>
      </div>

      <div style="background-color: #ffffff; padding: 20px; border-left: 4px solid #2563eb; margin: 20px 0;">
        <h3 style="color: #374151; margin-top: 0;">Message</h3>
        <p style="line-height: 1.6; white-space: pre-wrap;">${message}</p>
      </div>

      <div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; font-size: 0.9em; color: #6b7280;">
        <p><strong>Submission Details:</strong></p>
        <p>Time: ${new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto' })} (EST)</p>
        <p>Source: SpeskOn Contact Form</p>
        <p>IP: ${req.ip}</p>
      </div>

      <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; text-align: center; color: #6b7280; font-size: 0.8em;">
        <p>This message was sent through the Alan Performance Coaching website contact form.</p>
      </div>
    </div>`;

    const mailOptions = {
      from: `"SpeskOn Contact Form" <${process.env.EMAIL_USER || 'appointmentstudio1@gmail.com'}>`,
      to: process.env.ALAN_EMAIL || 'appointmentstudio1@gmail.com',
      subject: `🌟 ${subject} - From ${name}`,
      text: `
NEW CONTACT FORM SUBMISSION - ALAN PERFORMANCE COACHING

From: ${name}
Email: ${email}
${phone ? `Phone: ${phone}` : ''}
Preferred Contact: ${preferredContact}
Subject: ${subject}

Message:
${message}

---
Submitted: ${new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto' })} EST
Source: SpeskOn Contact Form
IP: ${req.ip}
      `,
      html: htmlContent,
      replyTo: email
    };

    // Auto-reply to user
    const userReplyOptions = {
      from: `"Alan Performance Coaching" <${process.env.EMAIL_USER || 'appointmentstudio1@gmail.com'}>`,
      to: email,
      subject: `Thank you for contacting Alan Performance Coaching, ${name}!`,
      html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">Thank you for reaching out, ${name}! 🌟</h2>
        
        <p>Your message has been received and I'm excited to connect with you about your performance coaching journey.</p>
        
        <div style="background-color: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #2563eb;">
          <h3 style="color: #1e40af; margin-top: 0;">What happens next?</h3>
          <ul style="line-height: 1.8;">
            <li>I'll personally review your message within 24 hours</li>
            <li>You'll receive a thoughtful response addressing your specific needs</li>
            <li>If you're interested in coaching, I'll offer you a complimentary discovery session</li>
          </ul>
        </div>

        <p><strong>Your message summary:</strong></p>
        <div style="background-color: #f9fafb; padding: 15px; border-radius: 6px;">
          <p><em>"${message.substring(0, 200)}${message.length > 200 ? '...' : ''}"</em></p>
        </div>

        <p>I'm looking forward to supporting you in achieving breakthrough performance and authentic success!</p>

        <p>Best regards,<br>
        <strong>Alan</strong><br>
        Performance Coach<br>
        📧 ${process.env.ALAN_EMAIL || 'appointmentstudio1@gmail.com'}<br>
        🌐 <a href="https://alan-three.vercel.app">Visit our website</a></p>

        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; text-align: center; color: #6b7280; font-size: 0.8em;">
          <p>This is an automated confirmation. Please don't reply to this email.</p>
        </div>
      </div>`
    };

    // Send both emails
    await Promise.all([
      transporter.sendMail(mailOptions),
      transporter.sendMail(userReplyOptions)
    ]);

    res.status(200).json({ 
      message: `Thank you, ${name}! Your message has been sent successfully. You should receive a confirmation email shortly, and Alan will respond within 24 hours.`,
      status: 'success',
      processingTime: Date.now() - start,
      autoReply: true
    });

    console.log(`[Contact] New submission from ${name} <${email}> processed in ${Date.now() - start}ms`);

  } catch (error) {
    console.error('Contact form error:', error);
    
    res.status(500).json({ 
      error: 'We apologize, but there was an issue sending your message. Please try again or contact us directly.',
      code: 'CONTACT_ERROR',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.listen(PORT, () => {
  console.log(`SpeskOn Performance Coach backend running on port ${PORT}`);
});
