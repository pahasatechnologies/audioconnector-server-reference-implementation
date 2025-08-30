import EventEmitter from 'events';
import { UltravoxService } from './ultravox-service';
import { Transcript } from './asr-service';

export class UltravoxASRService extends EventEmitter {
    private ultravoxService: UltravoxService;
    private state = 'None';
    private currentTranscript = '';

    constructor(apiKey: string) {
        super();
        this.ultravoxService = new UltravoxService({
            apiKey,
            systemPrompt: "You are a helpful assistant for customer service. Listen carefully to the customer's requests and provide helpful responses."
        });

        this.setupUltravoxHandlers();
    }

    private setupUltravoxHandlers() {
        this.ultravoxService.on('connected', () => {
            console.log('Ultravox ASR service connected');
            this.state = 'Ready';
        });

        this.ultravoxService.on('error', (error) => {
            console.error('Ultravox ASR error:', error);
            this.emit('error', error);
        });

        this.ultravoxService.on('message', (message) => {
            this.handleUltravoxMessage(message);
        });

        this.ultravoxService.on('audio', (audioBuffer) => {
            // Audio from Ultravox (TTS response)
            this.emit('audio-response', audioBuffer);
        });

        this.ultravoxService.on('disconnected', () => {
            this.state = 'Complete';
            this.emit('disconnected');
        });
    }

    private handleUltravoxMessage(message: any) {
        try {
            if (message.type === 'transcript') {
                this.currentTranscript = message.text || '';
                
                // Emit intermediate transcript
                this.emit('transcript', new Transcript(this.currentTranscript, message.confidence || 0.8));

                // If this is a final transcript
                if (message.isFinal) {
                    this.state = 'Complete';
                    this.emit('final-transcript', new Transcript(this.currentTranscript, message.confidence || 0.8));
                }
            } else if (message.type === 'agent_response') {
                // Handle agent response from Ultravox
                this.emit('agent-response', {
                    text: message.text,
                    confidence: message.confidence || 1.0
                });
            } else if (message.type === 'turn_end') {
                // Turn has ended, ready for next input
                this.state = 'Ready';
            }
        } catch (error) {
            console.error('Error handling Ultravox message:', error);
            this.emit('error', error);
        }
    }

    async initialize(): Promise<void> {
        try {
            await this.ultravoxService.connect();
        } catch (error) {
            console.error('Failed to initialize Ultravox ASR service:', error);
            throw error;
        }
    }

    getState(): string {
        return this.state;
    }

    processAudio(data: Uint8Array): void {
        if (this.state === 'Complete') {
            this.emit('error', 'Speech recognition has already completed.');
            return;
        }

        if (!this.ultravoxService.getConnectionStatus()) {
            console.warn('Cannot process audio: Ultravox not connected');
            return;
        }

        try {
            this.state = 'Processing';
            this.ultravoxService.sendAudio(data);
        } catch (error) {
            console.error('Error processing audio:', error);
            this.emit('error', error);
        }
    }

    disconnect(): void {
        this.ultravoxService.disconnect();
        this.state = 'Complete';
    }
}