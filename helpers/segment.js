import { Analytics } from '@segment/analytics-node';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the current file path and directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { SEGMENT_WRITE_KEY } = process.env;

// Initialize the Segment client
const analytics = new Analytics({writeKey: SEGMENT_WRITE_KEY});

/**
 * Tracks an event in Segment
 * @param {string} userId - The unique ID of the user
 * @param {string} event - The name of the event to track
 * @param {Object} properties - Additional properties to send with the event
 * @returns {Promise<void>}
 */
export const trackEvent = (userId, event, properties = {}) => {
    return new Promise((resolve, reject) => {
      analytics.track(
        {
          userId,
          event,
          properties,
        },
        (err, batch) => {
          if (err) {
            console.error('Error tracking event:', err);
            return reject(err);
          }
          console.log('Event tracked successfully:', batch);
          resolve(batch);
        }
      );
    });
  };
  
  /**
   * Flushes any remaining events before exit
   */
  export const flushAnalytics = () => {
    analytics.flush(() => {
      console.log('Analytics data flushed.');
    });
  };