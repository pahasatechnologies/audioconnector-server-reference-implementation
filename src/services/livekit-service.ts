import { Room, RoomEvent, RemoteParticipant, RemoteTrack, RemoteAudioTrack, Track, LocalAudioTrack, AudioCaptureOptions } from 'livekit-client';
import EventEmitter from 'events';
import AudioConverter from '../utils/audio-converter.js';
import { getLiveKitConfig } from '../config/livekit-config.js';

const LIVEKIT_SAMPLE_RATE = 8000;

export class LiveKitService extends EventEmitter {
  private room: Room | null = null;
  private isConnected: boolean = false;
  private roomName: string;
  private participantName: string;
  private config: any;
  private userPhoneNumber: string;
  private localAudioTrack: LocalAudioTrack | null = null;
  
  // Rate limiting for audio
  private audioQueue: Uint8Array[] = [];
  private audioSendInterval: NodeJS.Timeout | null = null;
  private audioSendRate: number = 50; // Send every 50ms
  private maxAudioQueueSize: number = 10;

  // Message rate limiting
  private messageQueue: any[] = [];
  private isProcessingMessages: boolean = false;
  private messageDelay: number = 10;

  // Transcript throttling
  private lastTranscriptTime: number = 0;
  private transcriptThrottleMs: number = 100;

  // Audio processing
  private audioContext: AudioContext | null = null;
  private audioWorkletNode: AudioWorkletNode | null = null;
  private mediaStreamSource: MediaStreamAudioSourceNode | null = null;

  constructor(phoneNumber: string = '+1234567890') {
    super();
    
    this.config = getLiveKitConfig();
    this.userPhoneNumber = phoneNumber;
    this.participantName = `${this.config.participantName}_${phoneNumber.replace(/[^0-9]/g, '')}`;
    this.roomName = `${this.config.roomPrefix}${Date.now()}`;

    console.log(`LiveKitService initialized with phone number: ${this.userPhoneNumber}`);
    console.log(`Room name: ${this.roomName}`);
  }

  private async generateAccessToken(): Promise<string> {
    try {
      const response = await fetch(this.config.tokenApiUrl, {
        method: 'POST',
        headers: {
          'accept': 'application/json, text/plain, */*',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          identity: this.userPhoneNumber,
          metadata: {
            email: this.config.email,
            mobile_number: this.userPhoneNumber,
            stt: "Self-Hosted",
            llm: "Self-Hosted", 
            tts: "Self-Hosted",
            orgId: this.config.orgId
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Token API request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      if (!data.token) {
        throw new Error('No token received from API');
      }

      return data.token;
    } catch (error) {
      console.error('Error generating access token:', error);
      throw new Error(`Failed to generate access token: ${error.message}`);
    }
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      throw new Error('Already connected to LiveKit');
    }

    try {
      console.log('Connecting to LiveKit...');
      
      this.room = new Room();
      
      // Set up event listeners
      this.setupEventListeners();
      
      const token = await this.generateAccessToken();
      
      await this.room.connect(this.config.wsUrl, token);
      
      this.isConnected = true;
      console.log('Connected to LiveKit successfully');
      
      // Start audio processing
      this.startAudioProcessing();
      
      this.emit('connected');
      
      // Set up audio publishing
      await this.setupAudioPublishing();
      
    } catch (error) {
      console.error('Failed to connect to LiveKit:', error);
      this.emit('error', error);
      throw error;
    }
  }

  private setupEventListeners(): void {
    if (!this.room) return;

    this.room.on(RoomEvent.Connected, () => {
      console.log('LiveKit room connected');
      this.emit('call_started');
    });

    this.room.on(RoomEvent.Disconnected, (reason) => {
      console.log('LiveKit room disconnected:', reason);
      this.isConnected = false;
      this.stopAudioProcessing();
      this.emit('disconnected');
    });

    this.room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      console.log('Participant connected:', participant.identity);
      this.handleParticipantConnected(participant);
    });

    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication, participant: RemoteParticipant) => {
      console.log('Track subscribed:', track.kind, 'from', participant.identity);
      
      if (track.kind === Track.Kind.Audio) {
        this.handleAudioTrack(track as RemoteAudioTrack);
      }
    });

    this.room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant) => {
      try {
        const message = JSON.parse(new TextDecoder().decode(payload));
        this.handleDataMessage(message, participant);
      } catch (error) {
        console.error('Error parsing data message:', error);
      }
    });

    this.room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      console.log('Connection quality changed:', quality, participant?.identity);
    });
  }

  private handleParticipantConnected(participant: RemoteParticipant): void {
    console.log(`Agent/Participant ${participant.identity} joined the room`);
  }

  private handleAudioTrack(track: RemoteAudioTrack): void {
    console.log('Handling audio track from agent');
    
    const mediaStreamTrack = track.mediaStreamTrack;
    
    if (mediaStreamTrack && typeof window !== 'undefined') {
      // Browser environment - use Web Audio API
      this.setupWebAudioProcessing(mediaStreamTrack);
    } else {
      // Node.js environment - handle differently
      console.log('Audio track received in Node.js environment');
      // In Node.js, you might need to use different audio processing libraries
    }
  }

  private setupWebAudioProcessing(mediaStreamTrack: MediaStreamTrack): void {
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
      
      // Create script processor to capture audio data
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      
      processor.onaudioprocess = (event) => {
        const inputBuffer = event.inputBuffer;
        const inputData = inputBuffer.getChannelData(0);
        
        // Convert float32 to PCM16 then to PCMU for Genesys
        const pcm16Buffer = this.float32ToPcm16(inputData);
        const pcmuBuffer = AudioConverter.convertPcm16ToPcmu(pcm16Buffer);
        
        this.emit('audio', pcmuBuffer);
      };
      
      source.connect(processor);
      processor.connect(audioContext.destination);
      
    } catch (error) {
      console.error('Error setting up web audio processing:', error);
    }
  }

  private float32ToPcm16(float32Array: Float32Array): Uint8Array {
    const pcm16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const sample = Math.max(-1, Math.min(1, float32Array[i]));
      pcm16Array[i] = sample * 0x7FFF;
    }
    return new Uint8Array(pcm16Array.buffer);
  }

  private handleDataMessage(message: any, participant?: RemoteParticipant): void {
    console.log('Data message received:', message);
    
    switch (message.type) {
      case 'transcript':
        this.handleTranscript(message);
        break;
      case 'agent_response':
        this.emit('agent_response', message);
        break;
      case 'state_change':
        this.emit('state', message);
        break;
      case 'call_ended':
        this.emit('call_ended', message);
        break;
      case 'playback_clear_buffer':
        this.emit('playback_clear_buffer');
        break;
      default:
        this.emit('message', message);
        break;
    }
  }

  private handleTranscript(message: any): void {
    const now = Date.now();
    
    // Throttle transcript events
    if (now - this.lastTranscriptTime < this.transcriptThrottleMs && !message.isFinal) {
      return;
    }
    
    this.lastTranscriptTime = now;
    
    this.emit('transcript', {
      text: message.text || '',
      isFinal: message.isFinal || false,
      role: message.role || 'agent',
    });
  }

  private async setupAudioPublishing(): Promise<void> {
    try {
      if (!this.room) return;
      
      // Create a custom audio track for publishing PCMU audio from Genesys
      // This is a simplified approach - in practice, you might need to create
      // a custom MediaStreamTrack from the audio data
      
      console.log('Audio publishing setup completed');
      
    } catch (error) {
      console.error('Error setting up audio publishing:', error);
      this.emit('error', error);
    }
  }

  private startAudioProcessing(): void {
    if (this.audioSendInterval) {
      clearInterval(this.audioSendInterval);
    }

    this.audioSendInterval = setInterval(() => {
      this.processAudioQueue();
    }, this.audioSendRate);
  }

  private stopAudioProcessing(): void {
    if (this.audioSendInterval) {
      clearInterval(this.audioSendInterval);
      this.audioSendInterval = null;
    }
    this.audioQueue = [];
  }

  private processAudioQueue(): void {
    if (this.audioQueue.length === 0 || !this.isConnected || !this.room) {
      return;
    }

    const audioData = this.audioQueue.shift();
    if (!audioData) return;

    try {
      // Convert PCMU to PCM16 for LiveKit
      const pcm16Buffer = AudioConverter.convertPcmuToPcm16(audioData);
      
      // Publish audio to LiveKit room
      this.publishAudioToRoom(pcm16Buffer);
      
    } catch (error) {
      console.error('Error processing audio from queue:', error);
      this.emit('error', error);
    }
  }

  private async publishAudioToRoom(pcm16Buffer: Uint8Array): Promise<void> {
    try {
      if (!this.room || !this.room.localParticipant) return;
      
      // In a real implementation, you would need to create a MediaStreamTrack
      // from the PCM16 audio data and publish it to the room
      // This is a complex process that involves creating audio buffers
      // and streaming them through the Web Audio API or similar
      
      // For now, we'll send the audio data as a data message
      // The LiveKit agent should be configured to handle this format
      const message = {
        type: 'audio_data',
        data: Array.from(pcm16Buffer),
        sampleRate: LIVEKIT_SAMPLE_RATE,
        format: 'pcm16'
      };
      
      await this.sendMessage(message);
      
    } catch (error) {
      console.error('Error publishing audio to room:', error);
    }
  }

  sendAudio(pcmuBuffer: Uint8Array): void {
    if (!this.isConnected) {
      console.warn('Cannot send audio: not connected to LiveKit');
      return;
    }

    // Add to queue instead of sending immediately
    this.audioQueue.push(pcmuBuffer);

    // Prevent queue from growing too large
    if (this.audioQueue.length > this.maxAudioQueueSize) {
      this.audioQueue.shift();
      console.warn('Audio queue overflow, dropping oldest audio data');
    }
  }

  sendMessage(message: any): Promise<void> {
    if (!this.isConnected || !this.room) {
      console.warn('Cannot send message: not connected to LiveKit');
      return Promise.resolve();
    }

    // Add to message queue for rate limiting
    this.messageQueue.push(message);
    return this.processMessageQueue();
  }

  private async processMessageQueue(): Promise<void> {
    if (this.isProcessingMessages || this.messageQueue.length === 0) {
      return;
    }

    this.isProcessingMessages = true;

    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();

      try {
        if (this.room && this.room.localParticipant) {
          const encoder = new TextEncoder();
          const data = encoder.encode(JSON.stringify(message));
          await this.room.localParticipant.publishData(data);
        }
      } catch (error) {
        console.error('Error sending message to LiveKit:', error);
        this.emit('error', error);
      }

      // Wait before sending next message
      if (this.messageQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, this.messageDelay));
      }
    }

    this.isProcessingMessages = false;
  }

  disconnect(): void {
    this.stopAudioProcessing();

    if (this.room) {
      this.room.disconnect();
      this.room = null;
    }
    
    this.isConnected = false;
    console.log('Disconnected from LiveKit');
  }

  getUserPhoneNumber(): string {
    return this.userPhoneNumber;
  }

  setUserPhoneNumber(phoneNumber: string): void {
    this.userPhoneNumber = phoneNumber;
    this.participantName = `${this.config.participantName}_${phoneNumber.replace(/[^0-9]/g, '')}`;
    console.log(`Phone number updated to: ${this.userPhoneNumber}`);
  }

  getRoomName(): string {
    return this.roomName;
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }
}