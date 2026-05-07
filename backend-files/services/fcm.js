const jwt = require('jsonwebtoken');
const axios = require('axios');
const serviceAccount = require('../eda-yedem-firebase-adminsdk-fbsvc-77d64b8c2c.json');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: serviceAccount.client_email,
    scope: FCM_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  };

  const signedJwt = jwt.sign(claim, serviceAccount.private_key, { algorithm: 'RS256' });

  const params = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + signedJwt;

  const response = await axios.post(TOKEN_URL, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  cachedToken = response.data.access_token;
  tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;
  return cachedToken;
}

async function sendPushNotification(fcmToken, title, body, data) {
  try {
    const accessToken = await getAccessToken();
    const projectId = serviceAccount.project_id;

    const message = {
      message: {
        token: fcmToken,
        notification: { title, body },
        android: {
          priority: 'high',
          notification: { sound: 'default', channel_id: 'orders' }
        }
      }
    };

    if (data) {
      message.message.data = {};
      Object.keys(data).forEach(function(key) {
        message.message.data[key] = String(data[key]);
      });
    }

    await axios.post(
      'https://fcm.googleapis.com/v1/projects/' + projectId + '/messages:send',
      message,
      {
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json'
        }
      }
    );
    return true;
  } catch (error) {
    console.error('FCM send error:', error.response ? JSON.stringify(error.response.data) : error.message);
    return false;
  }
}

module.exports = { sendPushNotification };
