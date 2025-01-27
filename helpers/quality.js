import OpenAI from 'openai';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the current file path and directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Load OpenAI API key from environment variables
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
  

/**
 * Function to check hallucinations using an AI model
 * @param {string} promptFile - The filename of the prompt inside 'assets/prompts'
 * @returns {Promise<string>} - The AI-generated completion response
 */
export const hallucinationCheck = async (messages) => {
    try {
      // Resolve the file path relative to the helpers folder
      const promptPath = path.resolve(process.cwd(), 'assets/prompts', 'hallucination-check.txt');
  
      // Read the prompt content from the file
      const promptContent = await fs.readFile(promptPath, 'utf-8');
  
      // Make a request to OpenAI's chat completion API
      const response = await openai.chat.completions.create({
        model: 'gpt-4o', 
        messages: [
          { role: 'system', content: promptContent },
          { role: 'user', content: JSON.stringify(messages)}
        ],
        max_tokens: 10000, 
        temperature: 0.7,
        response_format: {
            type: 'json_object'
        }
      });
  
      // Extract the AI response text
      const aiResponse = response.choices[0]?.message?.content || 'No response received.';
      return JSON.parse(aiResponse);
  
    } catch (error) {
      console.error('Error in hallucinationCheck:', error);
      throw new Error('Failed to generate hallucination check response');
    }
  };

  /**
 * Function to check the conversation quality using an AI model
 * @param {string} promptFile - The filename of the prompt inside 'assets/prompts'
 * @returns {Promise<string>} - The AI-generated completion response
 */
export const conversationQuality = async (messages) => {
    try {
      // Resolve the file paths for the prompt and schema relative to the current working directory
    const promptPath = path.resolve(process.cwd(), 'assets/prompts', 'conversation-quality.txt');
    const schemaPath = path.resolve(process.cwd(), 'assets/schemas', 'conversation_metrics.json');
  
    // Read the prompt content and JSON schema from files
    const [promptContent, schemaContent] = await Promise.all([
        fs.readFile(promptPath, 'utf-8'),
        fs.readFile(schemaPath, 'utf-8')
      ]);
    
    // Parse the schema JSON content
    const schema = JSON.parse(schemaContent);

    const { instructions } = await openai.beta.assistants.retrieve(
      process.env.OPENAI_ASSISTANT_ID
    );
  
    console.log(instructions);

    // Make a request to OpenAI's chat completion API
    const response = await openai.chat.completions.create({
        model: 'gpt-4o', 
        messages: [
            { role: 'system', content: promptContent },
            { role: 'user', content: instructions},
            { role: 'user', content: JSON.stringify(messages)}
        ],
        max_tokens: 10000, 
        temperature: 0.1,
        response_format: {
            type: 'json_schema',
            json_schema: schema
        }
    });

    // Extract the AI response text
    const aiResponse = response.choices[0]?.message?.content || 'No response received.';
    return JSON.parse(aiResponse);
  
    } catch (error) {
      console.error('Error in conversationQuality:', error);
      throw new Error('Failed to generate conversation quality response');
    }
  };