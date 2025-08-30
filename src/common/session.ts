import { v4 as uuid } from 'uuid';
import { WebSocket } from 'ws';
import {
    JsonStringMap,
    MediaParameter
} from '../protocol/core';
import {
    ClientMessage,
    DisconnectParameters,
    DisconnectReason,
    EventParameters,
    SelectParametersForType,
    ServerMessage,
    ServerMessageBase,
    ServerMessageType
} from '../protocol/message';
import {
    BotTurnDisposition,
    EventEntityBargeIn,
    EventEntityBotTurnResponse
} from '../protocol/voice-bots';
import { MessageHandlerRegistry } from '../websocket/message-handlers/message-handler-registry';
import { UltravoxService } from '../services/ultravox-service';
import { DTMFService } from '../services/dtmf-service';

export class Session {
    private MAXIMUM_BINARY_MESSAGE_SIZE = 64000;
    private disconnecting = false;
    private closed = false;
    private ws;

    private messageHandlerRegistry = new MessageHandlerRegistry();
    private ultravoxService: UltravoxService | null = null;
    private dtmfService: DTMFService | null = null;
    private url;
    private clientSessionId;
    private conversationId: string | undefined;
    private lastServerSequenceNumber = 0;
    private lastClientSequenceNumber = 0;
    private inputVariables: JsonStringMap = {};
    private selectedMedia: MediaParameter | undefined;
    private isCapturingDTMF = false;
    private isAudioPlaying = false;

    constructor(ws: WebSocket, sessionId: string, url: string) {
        this.ws = ws;
        this.clientSessionId = sessionId;
        this.url = url;
    }

    close() {
        if (this.closed) {
            return;
        }

        // Clean up Ultravox connection
        if (this.ultravoxService) {
            this.ultravoxService.disconnect();
        }

        try {
            this.ws.close();
        } catch {
        }

        this.closed = true;
    }

    setConversationId(conversationId: string) {
        this.conversationId = conversationId;
    }

    setInputVariables(inputVariables: JsonStringMap) { 
        this.inputVariables = inputVariables; 
    }

    setSelectedMedia(selectedMedia: MediaParameter) { 
        this.selectedMedia = selectedMedia; 
    }

    setIsAudioPlaying(isAudioPlaying: boolean) { 
        this.isAudioPlaying = isAudioPlaying; 
    }

    processTextMessage(data: string) {
        if (this.closed) {
            return;
        }

        const message = JSON.parse(data);

        if (message.seq !== this.lastClientSequenceNumber + 1) {
            console.log(`Invalid client sequence number: ${message.seq}.`);
            this.sendDisconnect('error', 'Invalid client sequence number.', {});
            return;
        }

        this.lastClientSequenceNumber = message.seq;

        if (message.serverseq > this.lastServerSequenceNumber) {
            console.log(`Invalid server sequence number: ${message.serverseq}.`);
            this.sendDisconnect('error', 'Invalid server sequence number.', {});
            return;
        }

        if (message.id !== this.clientSessionId) {
            console.log(`Invalid Client Session ID: ${message.id}.`);
            this.sendDisconnect('error', 'Invalid ID specified.', {});
            return;
        }

        const handler = this.messageHandlerRegistry.getHandler(message.type);

        if (!handler) {
            console.log(`Cannot find a message handler for '${message.type}'.`);
            return;
        }

        handler.handleMessage(message as ClientMessage, this);
    }

    createMessage<Type extends ServerMessageType, Message extends ServerMessage>(type: Type, parameters: SelectParametersForType<Type, Message>): ServerMessage {
        const message: ServerMessageBase<Type, typeof parameters> = {
            id: this.clientSessionId as string,
            version: '2',
            seq: ++this.lastServerSequenceNumber,
            clientseq: this.lastClientSequenceNumber,
            type,
            parameters
        };
    
        return message as ServerMessage;
    }

    send(message: ServerMessage) {
        if (message.type === 'event') {
            console.log(`Sending an ${message.type} message: ${message.parameters.entities[0].type}.`);
        } else {
            console.log(`Sending a ${message.type} message.`);
        }
        
        this.ws.send(JSON.stringify(message));
    }

    sendAudio(bytes: Uint8Array) {
        if (bytes.length <= this.MAXIMUM_BINARY_MESSAGE_SIZE) {
            console.log(`Sending ${bytes.length} binary bytes in 1 message.`);
            this.ws.send(bytes, { binary: true });
        } else {
            let currentPosition = 0;

            while (currentPosition < bytes.length) {
                const sendBytes = bytes.slice(currentPosition, currentPosition + this.MAXIMUM_BINARY_MESSAGE_SIZE);

                console.log(`Sending ${sendBytes.length} binary bytes in chunked message.`);
                this.ws.send(sendBytes, { binary: true });
                currentPosition += this.MAXIMUM_BINARY_MESSAGE_SIZE;
            }
        }
    }

    sendBargeIn() {
        const bargeInEvent: EventEntityBargeIn = {
            type: 'barge_in',
            data: {}
        };
        const message = this.createMessage('event', {
            entities: [bargeInEvent]
        } as SelectParametersForType<'event', EventParameters>);

        this.send(message);
    }

    sendTurnResponse(disposition: BotTurnDisposition, text: string | undefined, confidence: number | undefined) {
        const botTurnResponseEvent: EventEntityBotTurnResponse = {
            type: 'bot_turn_response',
            data: {
                disposition,
                text,
                confidence
            }
        };
        const message = this.createMessage('event', {
            entities: [botTurnResponseEvent]
        } as SelectParametersForType<'event', EventParameters>);

        this.send(message);
    }

    sendDisconnect(reason: DisconnectReason, info: string, outputVariables: JsonStringMap) {
        this.disconnecting = true;
        
        const disconnectParameters: DisconnectParameters = {
            reason,
            info,
            outputVariables
        };
        const message = this.createMessage('disconnect', disconnectParameters);

        this.send(message);
    }

    sendClosed() {
        const message = this.createMessage('closed', {});
        this.send(message);
    }

    checkIfBotExists(): Promise<boolean> {
        // Always return true since we'll create Ultravox connection on demand
        return Promise.resolve(true);
    }

    async processBotStart() {
        try {
            await this.initializeUltravox();
            
            // Send initial greeting
            this.sendTurnResponse('match', 'Hello! How can I help you today?', 1.0);
        } catch (error) {
            console.error('Error starting bot:', error);
            this.sendDisconnect('error', 'Failed to initialize conversation', {});
        }
    }

    private async initializeUltravox() {
        const apiKey = process.env.ULTRAVOX_API_KEY;
        if (!apiKey) {
            throw new Error('ULTRAVOX_API_KEY environment variable is required');
        }

        // Create system prompt based on input variables
        let systemPrompt = "You are a helpful customer service assistant. ";
        
        if (this.inputVariables.department) {
            systemPrompt += `You work in the ${this.inputVariables.department} department. `;
        }
        
        if (this.inputVariables.customerType) {
            systemPrompt += `You are assisting a ${this.inputVariables.customerType} customer. `;
        }

        systemPrompt += "Please be polite, professional, and helpful. Keep responses concise but informative.";

        this.ultravoxService = new UltravoxService({
            apiKey,
            systemPrompt,
            model: "fixie-ai/ultravox",
            voice: "Riya-Rao-English-Indian",
            sampleRate: 8000
        });

        // Set up event handlers
        this.ultravoxService.on('connected', () => {
            console.log('Ultravox connected successfully');
        });

        this.ultravoxService.on('error', (error) => {
            console.error('Ultravox error:', error);
            this.sendDisconnect('error', 'Conversation service error', {});
        });

        this.ultravoxService.on('audio', (audioBuffer) => {
            // Audio from Ultravox (TTS response) - send to Genesys
            this.sendAudio(audioBuffer);
        });

        this.ultravoxService.on('message', (message) => {
            this.handleUltravoxMessage(message);
        });

        this.ultravoxService.on('disconnected', () => {
            console.log('Ultravox disconnected');
        });

        await this.ultravoxService.connect();
    }

    private handleUltravoxMessage(message: any) {
        try {
            if (message.type === 'transcript') {
                // Handle transcript from Ultravox
                if (message.isFinal && message.text) {
                    this.sendTurnResponse('match', message.text, message.confidence || 0.9);
                }
            } else if (message.type === 'agent_response') {
                // Handle agent response from Ultravox
                this.sendTurnResponse('match', message.text, message.confidence || 1.0);
            } else if (message.type === 'turn_end') {
                // Turn has ended, ready for next input
                console.log('Turn ended');
            }
        } catch (error) {
            console.error('Error handling Ultravox message:', error);
        }
    }

    processBinaryMessage(data: Uint8Array) {
        if (this.disconnecting || this.closed) {
            return;
        }

        // Ignore audio if we are capturing DTMF
        if (this.isCapturingDTMF) {
            return;
        }

        // Handle barge-in by stopping current audio
        if (this.isAudioPlaying) {
            this.sendBargeIn();
            this.setIsAudioPlaying(false);
        }

        // Forward audio to Ultravox if connected
        if (this.ultravoxService && this.ultravoxService.getConnectionStatus()) {
            this.ultravoxService.sendAudio(data);
        }
    }

    processDTMF(digit: string) {
        if (this.disconnecting || this.closed) {
            return;
        }

        // Handle barge-in for DTMF
        if (this.isAudioPlaying) {
            this.sendBargeIn();
            this.setIsAudioPlaying(false);
        }

        // Flag DTMF capture mode
        if (!this.isCapturingDTMF) {
            this.isCapturingDTMF = true;
        }

        if (!this.dtmfService || this.dtmfService.getState() === 'Complete') {
            this.dtmfService = new DTMFService()
                .on('error', (error: any) => {
                    const message = 'Error during DTMF Capture.';
                    console.log(`${message}: ${error}`);
                    this.sendDisconnect('error', message, {});
                })
                .on('final-digits', (digits) => {
                    // Send DTMF digits as text message to Ultravox
                    if (this.ultravoxService && this.ultravoxService.getConnectionStatus()) {
                        this.ultravoxService.sendMessage({
                            type: 'user_message',
                            text: `DTMF input: ${digits}`
                        });
                    }
                    
                    this.isCapturingDTMF = false;
                });
        }

        this.dtmfService.processDigit(digit);
    }
}