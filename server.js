// Load environment variables
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3001;

// Create HTTP server
const server = http.createServer(app);

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*'
}));
app.use(express.json());

// OpenAI API Key from environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Validate required environment variables
if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY environment variable is required');
  console.error('Please create a .env file in the backend directory with your OpenAI API key');
  process.exit(1);
}

// Create ephemeral session endpoint
app.post('/api/session', async (req, res) => {
  try {
    console.log('Creating ephemeral session for OpenAI Realtime API...');
    
    const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview-2024-12-17',
        voice: 'alloy',
        modalities: ['text', 'audio'],
        instructions: 'You are a helpful AI assistant. Be concise and natural in your responses.',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1'
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API Error:', response.status, errorText);
      return res.status(response.status).json({
        error: 'Failed to create session',
        details: errorText
      });
    }

    const sessionData = await response.json();
    console.log('✅ Ephemeral session created successfully');
    
    // Return the ephemeral token to the client
    res.json({
      ephemeral_token: sessionData.client_secret.value,
      session_id: sessionData.id,
      expires_at: sessionData.expires_at
    });

  } catch (error) {
    console.error('Error creating ephemeral session:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Create WebSocket server for OpenAI Realtime API proxy
const wss = new WebSocket.Server({
  server,
  path: '/openai-realtime'
});

console.log('Setting up WebSocket proxy for OpenAI Realtime API...');

wss.on('connection', (clientWs, request) => {
  console.log('🔌 Client connected to WebSocket proxy');

  let openaiWs = null;

  // Handle messages from client
  clientWs.on('message', async (message, isBinary) => {
    try {
      console.log('🔍 Received message - isBinary:', isBinary, 'isBuffer:', Buffer.isBuffer(message), 'type:', typeof message);

      // Check if this is a JSON text message by trying to parse it
      let isJsonMessage = false;
      let data = null;

      try {
        const messageStr = message.toString();
        console.log('📝 Raw message content:', messageStr.substring(0, 200));
        data = JSON.parse(messageStr);
        isJsonMessage = true;
        console.log('✅ Successfully parsed JSON message:', data.type);
      } catch (parseError) {
        console.log('❌ Not a JSON message, treating as binary audio data');
        isJsonMessage = false;
      }

      // Handle binary audio data
      if (!isJsonMessage) {
        console.log('📤 Client binary message (audio data)', message.length, 'bytes');
        // Forward binary message to OpenAI if connected
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(message, { binary: true });
        }
        return;
      }

      // Handle JSON messages
      console.log('📤 Client JSON message:', data.type);

      // If this is the first message or connection is closed, establish connection to OpenAI
      if ((!openaiWs || openaiWs.readyState !== WebSocket.OPEN) && data.type === 'session.create') {
        console.log('🚀 Establishing connection to OpenAI Realtime API...');

        // Connect to OpenAI with proper authentication
        openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'realtime=v1'
          }
        });

        openaiWs.on('open', () => {
          console.log('✅ Connected to OpenAI Realtime API');
          // Forward the session.create message
          openaiWs.send(message);
        });

        openaiWs.on('message', (openaiMessage, isBinary) => {
          try {
            if (isBinary || Buffer.isBuffer(openaiMessage)) {
              console.log('📥 OpenAI binary message (audio data)', openaiMessage.length, 'bytes');
              // Forward binary message with proper binary flag
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(openaiMessage, { binary: true });
              }
            } else {
              // Handle text messages
              const messageStr = openaiMessage.toString();
              try {
                const messageData = JSON.parse(messageStr);
                console.log('📥 OpenAI text message:', messageData.type);
              } catch (parseError) {
                console.log('📥 OpenAI text message (non-JSON):', messageStr.substring(0, 100));
              }
              // Forward text message to client
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(openaiMessage, { binary: false });
              }
            }
          } catch (error) {
            console.error('❌ Error processing OpenAI message:', error);
            // Forward the message anyway with best guess for binary flag
            if (clientWs.readyState === WebSocket.OPEN) {
              const shouldBeBinary = Buffer.isBuffer(openaiMessage) || isBinary;
              clientWs.send(openaiMessage, { binary: shouldBeBinary });
            }
          }
        });

        openaiWs.on('error', (error) => {
          console.error('❌ OpenAI WebSocket error:', error);
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'error',
              error: {
                message: 'OpenAI connection error: ' + error.message,
                type: 'connection_error'
              }
            }));
          }
        });

        openaiWs.on('close', (code, reason) => {
          console.log('🔌 OpenAI WebSocket closed:', code, reason.toString());
          openaiWs = null;
          // Don't close client connection - let it stay open for reconnection
          console.log('🔄 OpenAI connection closed, but keeping client connection open for reconnection');
        });

      } else if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        // Forward other messages to OpenAI
        console.log('📤 Forwarding message to OpenAI:', data.type);
        openaiWs.send(message);
      } else {
        console.warn('⚠️ OpenAI connection not ready for message:', data.type);
        // If it's not a session.create message and OpenAI is not connected,
        // we should try to reconnect first
        if (data.type !== 'session.create') {
          console.log('🔄 Attempting to reconnect to OpenAI for message:', data.type);
          // Send an error back to client indicating connection issue
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'error',
              error: {
                message: 'OpenAI connection lost. Please reconnect.',
                type: 'connection_lost'
              }
            }));
          }
        }
      }

    } catch (error) {
      console.error('❌ Error processing client message:', error);
    }
  });

  clientWs.on('close', () => {
    console.log('🔌 Client disconnected from WebSocket proxy');
    if (openaiWs) {
      openaiWs.close();
    }
  });

  clientWs.on('error', (error) => {
    console.error('❌ Client WebSocket error:', error);
    if (openaiWs) {
      openaiWs.close();
    }
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Backend server running on http://localhost:${PORT}`);
  console.log(`📡 OpenAI Realtime API proxy ready`);
  console.log(`🔌 WebSocket proxy available at ws://localhost:${PORT}/openai-realtime`);
});
