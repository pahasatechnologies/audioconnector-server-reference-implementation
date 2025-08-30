# AudioConnector Server Reference Guide

## Ultravox Integration

This implementation has been enhanced to integrate with Ultravox for real-time speech recognition, text-to-speech, and conversational AI capabilities. The integration includes:

- **Real-time ASR**: Speech recognition powered by Ultravox
- **Natural TTS**: High-quality text-to-speech responses
- **Conversational AI**: Intelligent bot responses using Ultravox's language models
- **Audio Format Conversion**: Automatic conversion between PCMU (from Genesys) and PCM (for Ultravox)
- **Barge-in Support**: Interruption handling for natural conversations

### Purpose
This repository contains a sample implementation for an AudioConnector Server. This is to be used as a guide to help understand some of the basics of setting up an AudioConnector Server. It is not intended for production purposes. Protocol documentation can be found on the [Genesys Developer Portal](https://developer.genesys.cloud/devapps/audiohook/).

### Configuration

Before running the server, you need to configure your Ultravox API key:

1. Sign up for an Ultravox account at [https://dashboard.ultravox.ai/](https://dashboard.ultravox.ai/)
2. Get your API key from the dashboard
3. Update the `.env` file with your API key:
   ```
   ULTRAVOX_API_KEY=your_actual_api_key_here
   ```

### Things to look at to get started

#### Ultravox Integration Services
The [UltravoxService](./src/services/ultravox-service.ts) class handles the core connection and audio conversion between Genesys (PCMU) and Ultravox (PCM) formats.

The [UltravoxASRService](./src/services/ultravox-asr-service.ts) class replaces the dummy ASR implementation with real Ultravox speech recognition.

The [UltravoxBotService](./src/services/ultravox-bot-service.ts) class replaces the dummy bot implementation with Ultravox's conversational AI capabilities.

#### The main session object
The [Session](./src/common/session.ts) class contains methods and logic that handle communicating with the AudioConnector Client.

The [ASRService](./src/services/asr-service.ts) class is responsible for interpreting the incoming audio from the AudioConnector Server. This has been replaced with Ultravox integration.

The [BotService](./src/services/bot-service.ts) class is responsible for getting the metadata for a specified Bot, as well as interacting with the Bot itself. This has been enhanced with Ultravox integration.

The [DTMFService](./src/services/dtmf-service.ts) class is responsible for interpreting any DTMF digits received from the AudioConnector Client. A base implementation has been provded as a start, but will need to be adjusted to meet any specific requirements for the AudioConnector Server.

The [SecretService](./src/services/secret-service.ts) class is responsible for looking up the secret from a given API Key used during the initial authentication process. A fake implementation has been provided, and will need to be replaced to lookup secrets with whatever service they are stored in.

The [TTSService](./src/services/tts-service.ts) class is responsible for converting text-based responses from the Bot to the appropriate audio to be sent to the AudioConnector Client. This functionality is now handled by Ultravox integration.

### Running the server

#### Requirements
This implementation was written using NodeJS 18.16.0 as a target. If you are using a Node version manager, there is a [nvmrc](./.nvmrc) file that specifies this version.

#### Steps to run the server locally
1) Run `npm install` in the root of the project.
2) Configure your Ultravox API key in the `.env` file.
3) Run `npm run start` in the root of the project to start the server. The port can be adjusted from within the [environment](./.env) file.

### Audio Processing Features

The Ultravox integration includes advanced audio processing:

- **Format Conversion**: Seamless conversion between PCMU (8kHz, µ-law) and PCM16 (16-bit linear)
- **Audio Smoothing**: Reduces clicks and pops during format conversion
- **Noise Gate**: Filters out background noise below configurable thresholds
- **Soft Limiting**: Prevents audio clipping with smooth compression
- **Barge-in Support**: Handles interruptions gracefully for natural conversations

### Troubleshooting

- Ensure your Ultravox API key is valid and has sufficient credits
- Check that the ULTRAVOX_API_KEY environment variable is set correctly
- Monitor the console logs for connection status and error messages
- Verify that your network allows WebSocket connections to api.ultravox.ai