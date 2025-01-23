import twilio from 'twilio';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the current file path and directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Twilio credentials (use environment variables for security)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const syncServiceSid = process.env.TWILIO_SYNC_SERVICE_SID;

// Initialize Twilio client
const client = twilio(accountSid, authToken);

/**
 * Function to create or update a Twilio Sync document
 * @param {string} documentId - Unique ID for the Sync document
 * @param {Object} data - JSON object to store in the document
 */
export const createDocument = async (documentId, data) => {
    try {
      // Create or update the document
      const document = await client.sync.v1.services(syncServiceSid)
        .documents(documentId)
        .fetch()
        .then(() => {
          // Document exists, update it
          return client.sync.v1.services(syncServiceSid)
            .documents(documentId)
            .update({ data });
        })
        .catch(async (error) => {
          if (error.status === 404) {
            // Document doesn't exist, create it
            return client.sync.v1.services(syncServiceSid)
              .documents
              .create({
                uniqueName: documentId,
                data,
                ttl: 86400  // Time-to-live in seconds (1 day)
              });
          }
          throw error;
        });
  
      console.log('Sync document created/updated successfully:', document.sid);
      return document;
    } catch (error) {
      console.error('Error creating/updating Sync document:', error);
      throw error;
    }
  };

  export const getDocument = async (documentId) => {
    try {
      const document = await client.sync.v1.services(syncServiceSid)
        .documents(documentId)
        .fetch();
      
      console.log('Retrieved document:', document.data);
      return document.data;
    } catch (error) {
      console.error('Error retrieving document:', error);
      throw error;
    }
  };