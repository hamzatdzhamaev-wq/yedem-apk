/**
 * Capacitor Storage Adapter für localStorage Kompatibilität
 * Verwendet Capacitor Preferences auf Mobilgeräten, fällt zurück auf localStorage im Web
 */

// Capacitor Storage (async)
export const storage = {
  async getItem(key) {
    // Prüfen ob Capacitor verfügbar ist
    if (typeof window !== 'undefined' && window.Capacitor) {
      try {
        const { Preferences } = await import('@capacitor/preferences');
        const { value } = await Preferences.get({ key });
        return value;
      } catch (error) {
        console.error('Capacitor Preferences error:', error);
        return null;
      }
    }
    // Fallback zu localStorage (Web)
    if (typeof window !== 'undefined' && window.localStorage) {
      return localStorage.getItem(key);
    }
    return null;
  },

  async setItem(key, value) {
    if (typeof window !== 'undefined' && window.Capacitor) {
      try {
        const { Preferences } = await import('@capacitor/preferences');
        await Preferences.set({ key, value });
        return;
      } catch (error) {
        console.error('Capacitor Preferences error:', error);
      }
    }
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem(key, value);
    }
  },

  async removeItem(key) {
    if (typeof window !== 'undefined' && window.Capacitor) {
      try {
        const { Preferences } = await import('@capacitor/preferences');
        await Preferences.remove({ key });
        return;
      } catch (error) {
        console.error('Capacitor Preferences error:', error);
      }
    }
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.removeItem(key);
    }
  },

  async clear() {
    if (typeof window !== 'undefined' && window.Capacitor) {
      try {
        const { Preferences } = await import('@capacitor/preferences');
        await Preferences.clear();
        return;
      } catch (error) {
        console.error('Capacitor Preferences error:', error);
      }
    }
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.clear();
    }
  }
};

// Synchroner Wrapper mit Cache für Kompatibilität
const cache = new Map();

export const storageSync = {
  getItem(key) {
    return cache.get(key) || null;
  },

  setItem(key, value) {
    cache.set(key, value);
    storage.setItem(key, value); // Async im Hintergrund
  },

  removeItem(key) {
    cache.delete(key);
    storage.removeItem(key);
  }
};

// Cache initialisieren beim Start
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', async () => {
    // Wichtige Keys vorladen für schnellen Zugriff
    const keys = ['authToken', 'currentUser', 'theme', 'userLocation', 'cart'];

    for (const key of keys) {
      try {
        const value = await storage.getItem(key);
        if (value) {
          cache.set(key, value);
        }
      } catch (error) {
        console.error(`Failed to load ${key}:`, error);
      }
    }

    console.log('✅ Storage adapter initialized',
      window.Capacitor ? '(using Capacitor Preferences)' : '(using localStorage)');
  });
}
