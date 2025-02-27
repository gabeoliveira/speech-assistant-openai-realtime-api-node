import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import OpenAI from 'openai';
import shortid from 'shortid';

// Load environment variables from .env file
dotenv.config();

import { trackEvent } from './helpers/segment.js';
import { createDocument, getDocument } from './helpers/sync.js';
import { hallucinationCheck, conversationQuality } from './helpers/quality.js';
import petInsurancePlans from './assets/constants/insurance-plans.js';




// Retrieve the OpenAI API key from environment variables. You must have OpenAI Realtime API access.
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}
// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY
})

// Constants
const SYSTEM_MESSAGE = 'Você é um assistente de IA prestativo e animado, que adora conversar sobre qualquer assunto que interesse ao usuário e está sempre pronto para oferecer fatos. Você tem uma queda por piadas de "pai", piadas com corujas e gosta de dar uma rickroll de vez em quando – sutilmente. Sempre mantenha uma atitude positiva, mas insira uma piada quando for apropriado. Certifique-se de SEMPRE responder em português';
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment
// List of Event Types to log to the console. See OpenAI Realtime API Documentation. (session.updated is handled separately.)
const LOG_EVENT_TYPES = [
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});
// Route for Twilio to handle incoming and outgoing calls
// <Say> punctuation to improve text-to-speech translation
fastify.all('/incoming-call', async (request, reply) => {


    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Please wait while we connect your call to the A. I. voice assistant, powered by Twilio and the Open-A.I. Realtime API</Say>
                              <Pause length="1"/>
                              <Say>O.K. you can start talking!</Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;
    reply.type('text/xml').send(twimlResponse);
});


fastify.all('/incoming-call-direct', async (request, reply) => {


    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                            <Response>
                                <Redirect>https://webhooks.twilio.com/v1/Accounts/ACe981dae4f716a162dedcb0a1d3a2c168/Flows/FWcd6e2921030bc6ac86f964486b496b78</Redirect>
                            </Response>`;
    reply.type('text/xml').send(twimlResponse);
});

fastify.post('/call-post-processing', async (request, reply) => {
    console.log(request.body);

    const { SessionId: sessionId, SessionDuration: sessionDuration } = request.body;

    const { thread: threadId } = await getDocument(`session_${sessionId}`);

    const thread = await openai.beta.threads.retrieve(
        threadId
      );
    
    const { metadata } = thread;

    const threadMessages = await openai.beta.threads.messages.list(
        threadId,
        {limit: 100}
      );

    const strippedMessages = threadMessages.data.map(message => {
        return {
            role: message.role,
            content: message.content
        }
    } )
    
    /*try {
        fs.writeFileSync('messages.json', JSON.stringify(strippedMessages, null, 2));
        console.log(`Data successfully saved to ${filePath}`);
      } catch (error) {
        console.error('Error writing to file:', error);
      }*/

    const hallucinationData = await hallucinationCheck(strippedMessages);
    const qualityData = await conversationQuality(strippedMessages);

    console.log(qualityData);

    const eventData = {
        conversation_duration: sessionDuration,
        ...hallucinationData,
        ...qualityData
    }

    trackEvent(metadata.userId, 'Outbound Call Completed', eventData);

});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');
        console.log(OPENAI_API_KEY);
        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });
        let streamSid = null;
        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };
            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));
        };
        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(sendSessionUpdate, 250); // Ensure connection stability, send after .25 seconds
        });
        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }
                if (response.type === 'session.updated') {
                    console.log('Session updated successfully:', response);
                }
                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });
        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                console.log(data);
                switch (data.event) {
                    case 'media':
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });
        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });
        // Handle WebSocket close and errors
        openAiWs.on('close', (code, reason) => {
            console.log(`Disconnected from the OpenAI Realtime API. Code ${code}. Reason: ${reason}`);
        });
        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

fastify.register(async (fastify) => {
    fastify.get('/conversation-relay', { websocket: true }, async (connection, req) => {
        console.log('Client connected');

        let thread;
        let runId;
        let isRunActive = false;
        let conversationParams = {};
        
        // Handle incoming messages from Twilio
        connection.on('message', async (message) => {
            try {
                const data = JSON.parse(message);
                console.log(data);
                switch (data.type) {
                    case 'setup':
                        console.log('Setup Message');
                        conversationParams = { ...data.customParameters };
                        thread = await openai.beta.threads.create({ 
                            messages:[
                                {
                                    role: 'user',
                                    content: JSON.stringify(conversationParams)
                                }
                            ],
                            metadata: {
                                sessionId: data.sessionId,
                                userId: conversationParams.user_id
                            } 
                        });

                        trackEvent(data.customParameters.user_id, 'Outbound Call Answered', {reason: data.customParameters.reason});
                        createDocument(`session_${data.sessionId}`, {thread: thread.id});
                        break;

                    case 'prompt':
                        if (!thread) {
                            connection.send(JSON.stringify({ type: 'error', message: 'Thread not initialized.' }));
                            return;
                        }

                        if(isRunActive){
                            console.log('Active Run: ignoring prompt');
                            return;
                        }

                        await openai.beta.threads.messages.create(
                            thread.id,
                            {
                              role: "user",
                              content: data.voicePrompt
                            }
                            );
                        
                        isRunActive = true;

                        const run = openai.beta.threads.runs.stream(thread.id, {
                            assistant_id: process.env.OPENAI_ASSISTANT_ID
                            })
                            .on('runStepCreated', (runStep) => {
                                runId = runStep.run_id;
                                console.log(runId);

                            })
                            .on('textDelta', (textDelta, snapshot) => {
                                const text = {
                                    type: 'text',
                                    token: textDelta.value,
                                    last: false
                                };
                                connection.send(JSON.stringify(text));
                            })
                            .on('textDone', (text, snapshot) => {
                                const done = {
                                    type: 'text',
                                    token: '',
                                    last: true
                                };
                                connection.send(JSON.stringify(done));
                                isRunActive = false;
                                trackEvent(conversationParams.user_id, 'Assistant Interaction Sent', {body: text.value});

                            })
                            .on('toolCallDone', async (toolCall) => {
                                console.log(toolCall);

                                if(toolCall.type === 'function'){
                                    const functionArguments = JSON.parse(toolCall.function.arguments);
                                    
                                    switch(toolCall.function.name){
                                        case 'schedule_vaccination':
                                            try{

                                                                                
                                                const event = await trackEvent(functionArguments.user_id, 'Appointment Booked', {...functionArguments});                       

                                                const stream = await openai.beta.threads.runs.submitToolOutputs(thread.id, runId, {
                                                    stream: true,
                                                    tool_outputs: [
                                                        {
                                                            tool_call_id: toolCall.id,
                                                            output: JSON.stringify(event)
                                                        }
                                                    ]});


                                                    for await (const event of stream) {
                                                        if(event.event === 'thread.message.delta'){
                                                            console.log('Message Delta');
                                                            const text = {
                                                                type: 'text',
                                                                token: event.data.delta.content[0].text.value,
                                                                last: false
                                                            };
                                                            connection.send(JSON.stringify(text));

                                                        }
                                                        else if(event.event === 'thread.run.completed'){
                                                            console.log('Message Done');
                                                            const text = {
                                                                type: 'text',
                                                                token: '',
                                                                last: true
                                                            };
                                                            connection.send(JSON.stringify(text));
                                                            isRunActive = false;

                                                        }
                                                        
                                                      }


                                            } catch(err){
                                                console.error('Error handling tool call:', err);

                                                // Handle failure scenario by submitting an error response to the assistant
                                                await openai.beta.threads.runs.submitToolOutputs(thread.id, runId, {
                                                    tool_outputs: [
                                                        {
                                                            tool_call_id: toolCall.id,
                                                            output: JSON.stringify({
                                                                message: 'There was an error booking the appointment. Please try again.',
                                                                success: false
                                                            })
                                                        }
                                                    ]
                                                });

                    

                                            }

                                            break;

                                        case 'get_insurance_info':
                                            try{

                                                const stream = await openai.beta.threads.runs.submitToolOutputs(thread.id, runId, {
                                                    stream: true,
                                                    tool_outputs: [
                                                        {
                                                            tool_call_id: toolCall.id,
                                                            output: JSON.stringify(petInsurancePlans)
                                                        }
                                                    ]});


                                                    for await (const event of stream) {
                                                        if(event.event === 'thread.message.delta'){
                                                            console.log('Message Delta');
                                                            const text = {
                                                                type: 'text',
                                                                token: event.data.delta.content[0].text.value,
                                                                last: false
                                                            };
                                                            connection.send(JSON.stringify(text));

                                                        }

                                                        else if(event.event === 'thread.run.completed'){
                                                            console.log('Message Done');
                                                            const text = {
                                                                type: 'text',
                                                                token: '',
                                                                last: true
                                                            };
                                                            connection.send(JSON.stringify(text));
                                                            isRunActive = false;

                                                        }
                                                        
                                                      }


                                            } catch(err){
                                                console.error('Error handling tool call:', err);

                                                // Handle failure scenario by submitting an error response to the assistant
                                                await openai.beta.threads.runs.submitToolOutputs(thread.id, runId, {
                                                    tool_outputs: [
                                                        {
                                                            tool_call_id: toolCall.id,
                                                            output: JSON.stringify({
                                                                message: 'There was an error booking the appointment. Please try again.',
                                                                success: false
                                                            })
                                                        }
                                                    ]
                                                });

                    

                                            }

                                        break;

                                        case 'insurance_quote':
                                            try{

                                                const id = shortid.generate();
                                                console.log(id);

                                                const event = await trackEvent(functionArguments.user_id, 'Insurance Quote Started', {...functionArguments, quote_id: id});                       

                                                const stream = await openai.beta.threads.runs.submitToolOutputs(thread.id, runId, {
                                                    stream: true,
                                                    tool_outputs: [
                                                        {
                                                            tool_call_id: toolCall.id,
                                                            output: JSON.stringify(event)
                                                        }
                                                    ]});


                                                    for await (const event of stream) {
                                                        if(event.event === 'thread.message.delta'){
                                                            console.log('Message Delta');
                                                            const text = {
                                                                type: 'text',
                                                                token: event.data.delta.content[0].text.value,
                                                                last: false
                                                            };
                                                            connection.send(JSON.stringify(text));

                                                        }
                                                        else if(event.event === 'thread.run.completed'){
                                                            console.log('Message Done');
                                                            const text = {
                                                                type: 'text',
                                                                token: '',
                                                                last: true
                                                            };
                                                            connection.send(JSON.stringify(text));
                                                            isRunActive = false;

                                                        }
                                                        
                                                      }


                                            } catch(err){
                                                console.error('Error handling tool call:', err);

                                                // Handle failure scenario by submitting an error response to the assistant
                                                await openai.beta.threads.runs.submitToolOutputs(thread.id, runId, {
                                                    tool_outputs: [
                                                        {
                                                            tool_call_id: toolCall.id,
                                                            output: JSON.stringify({
                                                                message: 'There was an error booking the appointment. Please try again.',
                                                                success: false
                                                            })
                                                        }
                                                    ]
                                                });

                    

                                            }

                                        break;

                                        default:
                                            console.log('No function');
                                            break;
                                           
                                    }
                                }
                            });
                        trackEvent(conversationParams.user_id, 'Message Received', {body: data.voicePrompt});
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });
        // Handle connection close
        connection.on('close', () => {
            console.log('Client disconnected.');
        });
    });
});

fastify.listen({ port: PORT,host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});