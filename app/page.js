"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { track } from '@vercel/analytics';

export default function Home() {
  const [pois, setPois] = useState([]);
  const [activePoiId, setActivePoiId] = useState(null);
  const [activePoiQueues, setActivePoiQueues] = useState(null);
  const [pinnedHull, setPinnedHull] = useState('');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingInput, setOnboardingInput] = useState('');
  const [onboardingError, setOnboardingError] = useState('');
  const [tempHullInput, setTempHullInput] = useState('');
  const [showGuide, setShowGuide] = useState(false);
  
  // Track action custom helper for both Vercel & Google Analytics
  const trackAction = useCallback((eventName, params = {}) => {
    const enrichedParams = {
      ...params,
      driver_hull: pinnedHull || 'unknown',
    };
    try {
      track(eventName, enrichedParams);
    } catch (err) {
      console.warn('Vercel Analytics track error:', err);
    }
    try {
      if (typeof window !== 'undefined' && window.gtag) {
        window.gtag('event', eventName, enrichedParams);
      }
    } catch (err) {
      console.warn('Google Analytics track error:', err);
    }
  }, [pinnedHull]);

  const [wsStatus, setWsStatus] = useState('connecting'); // 'connecting' | 'connected' | 'disconnected'
  const [loadingPois, setLoadingPois] = useState(true);
  const [loadingQueues, setLoadingQueues] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const [lastUpdated, setLastUpdated] = useState('');

  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const reconnectDelay = useRef(5000);
  const activePoiIdRef = useRef(null);
  const wakeLockRef = useRef(null);
  const prevPosRef = useRef({ poiId: null, position: null, status: null });

  // Sync activePoiId to ref for access in WebSocket closure
  useEffect(() => {
    activePoiIdRef.current = activePoiId;
  }, [activePoiId]);

  // Helper: Format and validate hull number matching backend format
  const formatHullNumber = (val) => {
    if (!val) return '';
    let trimmed = val.trim().toLowerCase();
    
    // Remove "gt-" or "gt" prefix if user entered it
    trimmed = trimmed.replace(/^(gt-?|gt\s+)/, '');
    
    let originalNum = parseInt(trimmed, 10);
    if (trimmed.length >= 5 && trimmed.startsWith('1')) {
      const lastFour = trimmed.slice(-4);
      originalNum = parseInt(lastFour, 10);
    }
    
    if (isNaN(originalNum) || originalNum <= 0 || originalNum > 1500) {
      return null;
    }
    
    const paddedNum = String(originalNum).padStart(4, '0');
    return `GT-1${paddedNum}`;
  };

  // Load pinned hull number from localStorage on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('pinnedHull') || '';
      setPinnedHull(stored);
      setTempHullInput(stored);
      
      const skipped = localStorage.getItem('skipOnboarding') === 'true';
      if (!stored && !skipped) {
        setShowOnboarding(true);
      }
    }
  }, []);

  // Sync tempHullInput when pinnedHull changes (e.g. from onboarding)
  useEffect(() => {
    setTempHullInput(pinnedHull);
  }, [pinnedHull]);

  // Handle pinned hull number changes from detail view input
  const handleSaveHullInput = (val) => {
    const trimmed = val.trim();
    if (!trimmed) {
      trackAction('clear_pinned_hull');
      setPinnedHull('');
      if (typeof window !== 'undefined') {
        localStorage.removeItem('pinnedHull');
      }
      return;
    }
    const formatted = formatHullNumber(trimmed);
    if (formatted) {
      trackAction('save_pinned_hull', { hull_number: formatted });
      setPinnedHull(formatted);
      if (typeof window !== 'undefined') {
        localStorage.setItem('pinnedHull', formatted);
      }
    } else {
      // Revert if invalid
      setTempHullInput(pinnedHull);
    }
  };

  // Onboarding Save Handler
  const handleOnboardingSave = () => {
    const val = onboardingInput.trim();
    if (!val) {
      setOnboardingError('Nomor lambung tidak boleh kosong.');
      return;
    }
    const formatted = formatHullNumber(val);
    if (formatted) {
      trackAction('save_onboarding_hull', { hull_number: formatted });
      setPinnedHull(formatted);
      if (typeof window !== 'undefined') {
        localStorage.setItem('pinnedHull', formatted);
      }
      setShowOnboarding(false);
    } else {
      setOnboardingError('Format salah. Masukkan angka 1 - 1500.');
    }
  };

  // Onboarding Skip Handler
  const handleOnboardingSkip = () => {
    trackAction('skip_onboarding');
    if (typeof window !== 'undefined') {
      localStorage.setItem('skipOnboarding', 'true');
    }
    setShowOnboarding(false);
  };

  // Determine API & WS endpoints dynamically based on current location
  const getApiUrl = () => {
    if (typeof window !== 'undefined') {
      const hostname = window.location.hostname;
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return 'http://localhost:5050';
      }
    }
    return 'https://api.nadir.my.id';
  };

  const getWsUrl = () => {
    if (typeof window !== 'undefined') {
      const hostname = window.location.hostname;
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return 'ws://localhost:5051';
      }
    }
    return 'wss://ws.nadir.my.id';
  };

  // Helper: Format Current Time to 12-hour format (e.g. 12:45 PM)
  const formatCurrentTime = () => {
    const now = new Date();
    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // 0 hour should be 12
    const hoursStr = String(hours).padStart(2, '0');
    return `${hoursStr}:${minutes} ${ampm}`;
  };

  // Fetch all POIs
  const fetchPois = useCallback(async (isManual = false) => {
    if (isManual) setIsRefreshing(true);
    try {
      const apiUrl = getApiUrl();
      const res = await fetch(`${apiUrl}/api/pois`);
      if (!res.ok) throw new Error('Gagal memuat data pangkalan');
      const data = await res.json();
      
      // Filter only the 4 main pangkalan: PCM, RP, TP, PTC
      const filtered = data.filter(poi => ['PCM', 'RP', 'TP', 'PTC'].includes(poi.code));
      
      // Sort pois in custom order: PTC, PCM, RP, TP to match mockup
      const order = { PTC: 1, PCM: 2, RP: 3, TP: 4 };
      filtered.sort((a, b) => (order[a.code] || 99) - (order[b.code] || 99));

      setPois(filtered);
      setLastUpdated(formatCurrentTime());
      setError(null);
    } catch (err) {
      console.error(err);
      setError(err.message);
    } finally {
      setLoadingPois(false);
      if (isManual) {
        setTimeout(() => setIsRefreshing(false), 600);
      }
    }
  }, []);

  // Fetch active queues for a specific POI
  const fetchPoiQueues = useCallback(async (poiId) => {
    setLoadingQueues(true);
    try {
      const apiUrl = getApiUrl();
      const res = await fetch(`${apiUrl}/api/pois/${poiId}/queues`);
      if (!res.ok) throw new Error('Gagal mengambil data antrean');
      const data = await res.json();
      setActivePoiQueues(data);
    } catch (err) {
      console.error('Error fetching queues:', err);
    } finally {
      setLoadingQueues(false);
    }
  }, []);

  // WebSocket Connection with Auto Reconnect (Exponential Backoff)
  const connectWS = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.CONNECTING || wsRef.current.readyState === WebSocket.OPEN)) {
      return;
    }

    setWsStatus('connecting');
    const wsUrl = getWsUrl();
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus('connected');
      reconnectDelay.current = 5000; // reset delay to 5s
      fetchPois(); // Refresh data on connection
      if (activePoiIdRef.current) {
        fetchPoiQueues(activePoiIdRef.current);
      }
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'QUEUE_UPDATE') {
          // Always refresh general list counts
          fetchPois();
          // If the updated POI matches the one currently open, refresh queue details
          if (activePoiIdRef.current && activePoiIdRef.current === message.poiId) {
            fetchPoiQueues(message.poiId);
          }
        }
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    ws.onclose = () => {
      setWsStatus('disconnected');
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectDelay.current = Math.min(reconnectDelay.current * 1.5, 30000);
        connectWS();
      }, reconnectDelay.current);
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      ws.close();
    };
  }, [fetchPois, fetchPoiQueues]);

  // Screen Wake Lock API: Keep screen awake
  const requestWakeLock = async () => {
    if (typeof window !== 'undefined' && 'wakeLock' in navigator) {
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        console.log('Screen Wake Lock aktif.');
      } catch (err) {
        console.warn('Gagal mengaktifkan Screen Wake Lock:', err.message);
      }
    }
  };

  const releaseWakeLock = () => {
    if (wakeLockRef.current) {
      wakeLockRef.current.release()
        .then(() => {
          console.log('Screen Wake Lock dinonaktifkan.');
          wakeLockRef.current = null;
        });
    }
  };

  // Play Web Audio Beep Notification (Offline/Native Beep)
  const playBeep = () => {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      
      const playTone = (freq, duration, startTime) => {
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(freq, startTime);
        
        gainNode.gain.setValueAtTime(0.08, startTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
        
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        oscillator.start(startTime);
        oscillator.stop(startTime + duration);
      };

      // Play double pleasant beep (A5 then C6)
      playTone(880, 0.1, audioCtx.currentTime);
      playTone(1046.5, 0.15, audioCtx.currentTime + 0.12);
    } catch (err) {
      console.warn('Failed to play web audio notification:', err);
    }
  };

  // Tracking Queue Position changes to trigger Sound Beep
  useEffect(() => {
    if (!activePoiQueues || !pinnedHull) {
      prevPosRef.current = { poiId: null, position: null, status: null };
      return;
    }

    const poiId = activePoiQueues.poi.id;
    const normalizedPin = pinnedHull.trim().toLowerCase();
    if (!normalizedPin) {
      prevPosRef.current = { poiId: null, position: null, status: null };
      return;
    }

    let newPos = null;
    let newStatus = null;

    // Search in Standby Queue
    const standbyIndex = (activePoiQueues.standby || []).findIndex(
      item => item.hullNumber.trim().toLowerCase() === normalizedPin
    );

    if (standbyIndex !== -1) {
      newPos = standbyIndex + 1;
      newStatus = 'standby';
    } else {
      // Search in Tandon Queue
      const tandonIndex = (activePoiQueues.tandon || []).findIndex(
        item => item.hullNumber.trim().toLowerCase() === normalizedPin
      );
      if (tandonIndex !== -1) {
        newPos = tandonIndex + 1;
        newStatus = 'tandon';
      }
    }

    const prev = prevPosRef.current;

    // Trigger beep if driver moved up in the same station's queues
    if (prev.poiId === poiId && prev.position !== null && newPos !== null) {
      const movedUpInStatus = prev.status === 'tandon' && newStatus === 'standby';
      const movedUpInPosition = prev.status === newStatus && newPos < prev.position;

      if (movedUpInStatus || movedUpInPosition) {
        console.log('Posisi driver naik! Bunyikan beep.');
        playBeep();
      }
    }

    // Save current position for next comparison
    prevPosRef.current = { poiId, position: newPos, status: newStatus };
  }, [activePoiQueues, pinnedHull]);

  // Initial Load, WebSocket setup, and Screen Wake Lock acquisition
  useEffect(() => {
    fetchPois();
    connectWS();
    requestWakeLock();

    // Register PWA Service Worker (Hanya di mode produksi untuk menghindari loop dev HMR)
    if (process.env.NODE_ENV === 'production' && typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js')
        .then((reg) => console.log('Service Worker terdaftar:', reg.scope))
        .catch((err) => console.warn('Pendaftaran Service Worker gagal:', err));
    } else if (process.env.NODE_ENV === 'development' && typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      // Hapus service worker lama di mode dev secara otomatis agar tidak mengganggu HMR
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (let registration of registrations) {
          registration.unregister().then((success) => {
            if (success) {
              console.log('Service Worker lama dihapus otomatis untuk membersihkan dev HMR.');
              window.location.reload();
            }
          });
        }
      });
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      releaseWakeLock();
    };
  }, [fetchPois, connectWS]);

  // Page Visibility API Integration
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log('Halaman aktif kembali. Menyegarkan data...');
        fetchPois();
        if (activePoiIdRef.current) {
          fetchPoiQueues(activePoiIdRef.current);
        }
        connectWS();
        requestWakeLock();
      } else {
        releaseWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [fetchPois, connectWS]);

  // Background polling when in error/offline state
  useEffect(() => {
    if (!error) return;
    const interval = setInterval(() => {
      console.log('Background polling POIs karena status offline...');
      fetchPois(false);
    }, 15000);
    return () => clearInterval(interval);
  }, [error, fetchPois]);

  // Hash Navigation Handler
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash;
      const match = hash.match(/^#\/poi\/(\d+)$/);
      if (match) {
        const poiId = parseInt(match[1], 10);
        setActivePoiId(poiId);
        fetchPoiQueues(poiId);
      } else {
        setActivePoiId(null);
        setActivePoiQueues(null);
      }
    };

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [fetchPoiQueues]);

  // Real-time ticking for queue duration updates every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // Helper: Calculate WIB Hour (UTC+7)
  const getWibHour = () => {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const wib = new Date(utc + (3600000 * 7));
    return wib.getHours();
  };

  // Helper: Check if POI is open based on WIB Hour
  const isPoiOpen = (poi) => {
    const currentHour = getWibHour();
    return currentHour >= poi.onlineHour && currentHour < poi.offlineHour;
  };

  // Helper: Format hour number to HH:00
  const formatHour = (h) => {
    return String(h).padStart(2, '0') + ':00';
  };

  // Helper: Format POI Names to Title Case
  const toTitleCase = (str) => {
    if (!str) return '';
    return str.replace(/\w\S*/g, (txt) => {
      return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
    });
  };

  // Helper: Get POI Locations (Matching Mockup in Indonesian)
  const getPoiLocation = (code) => {
    const locations = {
      PTC: 'Surabaya Barat',
      PCM: 'Surabaya Timur',
      RP: 'Surabaya Pusat',
      TP: 'Pusat Kota'
    };
    return locations[code] || 'Surabaya';
  };

  // Helper: Calculate queue duration text
  const getDurationText = (joinedAtStr) => {
    if (!joinedAtStr) return '-';
    const joined = new Date(joinedAtStr).getTime();
    const diffMs = Date.now() - joined;
    const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));
    if (diffMinutes < 60) {
      return `${diffMinutes}m`;
    }
    const hours = Math.floor(diffMinutes / 60);
    const mins = diffMinutes % 60;
    return `${hours}j ${mins}m`;
  };

  // Helper: Format join timestamp
  const formatJoinTime = (dateStr) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  };

  // Handle POI Card Click
  const handlePoiClick = (poiId) => {
    const clickedPoi = pois.find(p => p.id === poiId);
    if (clickedPoi) {
      trackAction('view_pangkalan_detail', {
        poi_id: poiId,
        poi_code: clickedPoi.code,
        poi_name: clickedPoi.name
      });
    }
    window.location.hash = `#/poi/${poiId}`;
  };

  // Handle Back Button Click
  const handleBackClick = () => {
    trackAction('click_back_to_home');
    window.location.hash = '';
  };

  // Handle Manual Refresh Button
  const handleManualRefresh = () => {
    if (isRefreshing) return;
    trackAction('click_manual_refresh', {
      active_poi_code: activePoi?.code || 'none'
    });
    fetchPois(true);
    if (activePoiId) {
      fetchPoiQueues(activePoiId);
    }
  };

  // Get currently selected POI object
  const activePoi = pois.find(p => p.id === activePoiId);

  // Connection status helpers for UI
  const getStatusText = () => {
    if (wsStatus === 'connected' && !error) return 'TERHUBUNG';
    if (error) return 'SERVER OFFLINE';
    if (wsStatus === 'connecting') return 'MENGHUBUNGKAN...';
    return 'TERPUTUS';
  };

  const getStatusClass = () => {
    if (wsStatus === 'connected' && !error) return 'connected';
    if (error) return 'disconnected'; // Red color
    if (wsStatus === 'connecting') return 'connecting'; // Orange color
    return 'disconnected';
  };

  const statusClass = getStatusClass();

  return (
    <div className="app-container">
      {/* HEADER */}
      <header className="app-header">
        <div className="brand-section">
          {/* Taxi / Sedan silhouette SVG with taxi sign on roof */}
          <svg className="brand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            {/* Taxi Sign */}
            <path d="M9 4h6v3H9V4z" fill="currentColor" />
            {/* Car body */}
            <path d="M3 13h18M5 13l1.5-4.5h11L19 13M3 13v4c0 .6.4 1 1 1h1a2 2 0 0 0 4 0h6a2 2 0 0 0 4 0h1c.6 0 1-.4 1-1v-4" />
            {/* Wheels */}
            <circle cx="7.5" cy="17.5" r="1.5" fill="currentColor" />
            <circle cx="16.5" cy="17.5" r="1.5" fill="currentColor" />
          </svg>
          <span className="app-title">Antrean POI GSM</span>
        </div>
        <div className="header-actions">
          <button 
            className="info-button" 
            onClick={() => {
              trackAction('click_help_guide');
              setShowGuide(true);
            }} 
            title="Panduan Antrean WhatsApp"
          >
            i
          </button>
          <div 
            className="connection-status" 
            style={{ 
              color: statusClass === 'connected' ? 'var(--color-success)' : statusClass === 'connecting' ? 'var(--color-warning)' : 'var(--color-danger)',
              backgroundColor: statusClass === 'connected' ? 'rgba(16, 185, 129, 0.05)' : statusClass === 'connecting' ? 'rgba(245, 158, 11, 0.05)' : 'rgba(239, 68, 68, 0.05)',
              borderColor: statusClass === 'connected' ? 'rgba(16, 185, 129, 0.15)' : statusClass === 'connecting' ? 'rgba(245, 158, 11, 0.15)' : 'rgba(239, 68, 68, 0.15)'
            }}
          >
            <span className={`status-dot ${statusClass}`}></span>
            <span>{getStatusText()}</span>
          </div>
        </div>
      </header>

      {/* MAIN CONTAINER */}
      <main className="app-main">

        {loadingPois && pois.length === 0 ? (
          <div className="loading-container">
            <div className="spinner"></div>
            <p>Memuat data pangkalan...</p>
          </div>
        ) : error && pois.length === 0 ? (
          <div className="offline-container">
            <div className="offline-icon-box">
              <svg className="offline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0 1 19 12.5a12.9 12.9 0 0 1-3.54 5.34M12 12.5a12.78 12.78 0 0 1-5.11-2M1.39 6.72A11 11 0 0 1 5 5.5a12.9 12.9 0 0 1 11.83 2.15" />
                <line x1="12" y1="17" x2="12.01" y2="17" strokeWidth="3" />
              </svg>
            </div>
            <h3 className="offline-title">Koneksi Terputus</h3>
            <p className="offline-desc">
              Gagal menghubungkan ke server antrean. Pastikan perangkat Anda terhubung ke internet atau coba lagi beberapa saat lagi.
            </p>
            <button className="offline-retry-btn" onClick={() => {
              trackAction('click_offline_retry');
              fetchPois(false);
            }} disabled={isRefreshing}>
              {isRefreshing ? (
                <>
                  <span className="spinner-mini"></span>
                  Menghubungkan...
                </>
              ) : (
                'Coba Hubungkan Kembali'
              )}
            </button>
            <p className="offline-retry-status">
              <span className="pulsing-dot-orange"></span>
              Menghubungkan kembali otomatis di latar belakang...
            </p>
          </div>
        ) : (
          <div className="poi-grid-wrapper">
            {error && (
              <div className="offline-banner">
                <svg className="banner-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <span>Gagal memperbarui data. Menampilkan data terakhir.</span>
              </div>
            )}
            <div className="poi-grid">
            {pois.map((poi) => {
              const open = isPoiOpen(poi);
              const standbyPercentage = Math.min(100, Math.round((poi.standbyCount / Math.max(1, poi.maxStandby)) * 100));
              const tandonPercentage = Math.min(100, Math.round((poi.tandonCount / Math.max(1, poi.maxTandon)) * 100));
              
              return (
                <div 
                  key={poi.id} 
                  className="poi-card" 
                  onClick={() => handlePoiClick(poi.id)}
                >
                  {/* POI Header Block */}
                  <div className="poi-card-header">
                    <div className="poi-logo-badge">{poi.code}</div>
                    <div className="poi-details-block">
                      <div className="poi-title-row">
                        <span className="poi-name">{toTitleCase(poi.name)}</span>
                        <span className={`status-badge ${open ? 'buka' : 'tutup'}`}>
                          {open ? 'BUKA' : 'TUTUP'}
                        </span>
                      </div>
                      <div className="poi-location">
                        {/* Map Pin Icon */}
                        <svg className="location-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                          <circle cx="12" cy="10" r="3" />
                        </svg>
                        <span>{getPoiLocation(poi.code)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Side-by-side Progress Bars */}
                  <div className="poi-progress-row">
                    {/* Standby Column */}
                    <div className="progress-col">
                      <div className="progress-header">
                        <span className="progress-label">STANDBY</span>
                        <span className="progress-val">{poi.standbyCount}/{poi.maxStandby}</span>
                      </div>
                      <div className="progress-bar-container">
                        <div 
                          className="progress-bar-fill standby" 
                          style={{ width: `${standbyPercentage}%` }}
                        ></div>
                      </div>
                    </div>

                    {/* Tandon Column */}
                    <div className="progress-col">
                      <div className="progress-header">
                        <span className="progress-label">TANDON</span>
                        <span className="progress-val">{poi.tandonCount}/{poi.maxTandon}</span>
                      </div>
                      <div className="progress-bar-container">
                        <div 
                          className="progress-bar-fill tandon" 
                          style={{ width: `${tandonPercentage}%` }}
                        ></div>
                      </div>
                    </div>
                  </div>

                  {/* Metadata Row Removed for Compactness */}
                </div>
              );
            })}
          </div>
        </div>
      )}
      </main>

      {/* FOOTER */}
      {!loadingPois && pois.length > 0 && (
        <footer className="app-footer">
          <div className="footer-top-row">
            <div className="last-updated">
              {/* Sync icon that rotates when manually refreshed */}
              <svg className={`sync-icon ${isRefreshing ? 'spinning' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
              <span>Diperbarui: {lastUpdated}</span>
            </div>
            <button 
              className="refresh-button" 
              onClick={handleManualRefresh}
              disabled={isRefreshing}
            >
              {isRefreshing ? 'Memperbarui...' : 'Refresh Manual'}
            </button>
          </div>
          <div className="footer-credits">
            Dari Driver Green SM Surabaya untuk Rekan Driver GSM
          </div>
        </footer>
      )}

      {/* DETAIL VIEW OVERLAY */}
      {activePoiId && activePoi && (
        <div className="detail-view">
          <header className="detail-header">
            <button className="back-button" onClick={handleBackClick}>←</button>
            <div className="detail-header-info">
              <h2 className="detail-poi-name">{activePoi.code} - {toTitleCase(activePoi.name)}</h2>
              <span className="detail-poi-status">
                <span 
                  className="status-indicator-dot" 
                  style={{ backgroundColor: isPoiOpen(activePoi) ? 'var(--color-success)' : 'var(--color-danger)' }}
                ></span>
                {isPoiOpen(activePoi) ? 'Buka Sekarang' : 'Sedang Tutup'} • Operasional: {formatHour(activePoi.onlineHour)} - {formatHour(activePoi.offlineHour)} WIB
              </span>
            </div>
          </header>

          <div className="detail-summary-panel">
            <div className="summary-box">
              <span className="summary-label">STANDBY</span>
              <span className="summary-val">
                {activePoi.standbyCount}/{activePoi.maxStandby}
              </span>
            </div>
            <div className="summary-box">
              <span className="summary-label">TANDON</span>
              <span className="summary-val">
                {activePoi.tandonCount}/{activePoi.maxTandon}
              </span>
            </div>
            <div className="summary-box">
              <span className="summary-label">RATA TUNGGU</span>
              <span className="summary-val" style={{ color: 'var(--color-success)' }}>
                {activePoi.avgWaitFormatted || '0m'}
              </span>
            </div>
          </div>

          {/* PIN DRIVER INPUT PANEL */}
          <div className="pin-input-container">
            <div className="pin-label">
              <svg className="location-icon" style={{ color: 'var(--text-accent)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              <span>Driver Saya:</span>
            </div>
            <div className="pin-input-wrapper">
              <input 
                type="text" 
                className="pin-input" 
                placeholder="Masukkan No. Lambung..." 
                value={tempHullInput} 
                onChange={(e) => setTempHullInput(e.target.value)}
                onBlur={() => handleSaveHullInput(tempHullInput)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveHullInput(tempHullInput);
                }}
              />
              {tempHullInput && (
                <button 
                  className="pin-clear-btn" 
                  onClick={() => {
                    trackAction('clear_pinned_hull');
                    setPinnedHull('');
                    setTempHullInput('');
                    if (typeof window !== 'undefined') {
                      localStorage.removeItem('pinnedHull');
                    }
                  }}
                >
                  ×
                </button>
              )}
            </div>
          </div>

          <div className="queue-list-container" style={{ overflowY: 'auto' }}>
            {error && (
              <div className="offline-banner" style={{ margin: '0 16px 12px 16px' }}>
                <svg className="banner-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <span>Gagal memperbarui antrean. Menampilkan data terakhir.</span>
              </div>
            )}
            {loadingQueues && (!activePoiQueues || tick === 0) ? (
              <div className="loading-container">
                <div className="spinner"></div>
                <p>Memuat daftar antrean...</p>
              </div>
            ) : (
              <>
                {/* SECTION 1: STANDBY QUEUE */}
                <div className="detail-section">
                  <div className="section-header standby-header">
                    <span className="section-title">⚡ Antrean Standby</span>
                    <span className="section-count">
                      {activePoiQueues?.standby?.length || 0} / {activePoi.maxStandby}
                    </span>
                  </div>
                  {(!activePoiQueues?.standby || activePoiQueues.standby.length === 0) ? (
                    <div className="queue-empty" style={{ padding: '32px 16px' }}>
                      <span className="queue-empty-title">Tidak ada antrean standby</span>
                      <span className="queue-empty-desc">Pangkalan standby kosong untuk saat ini.</span>
                    </div>
                  ) : (
                    <div className="queue-list">
                      {activePoiQueues.standby.map((item, index) => {
                        const isFirst = index === 0;
                        const isPinned = pinnedHull && item.hullNumber.trim().toLowerCase() === pinnedHull.trim().toLowerCase();
                        return (
                          <div 
                            key={item.id} 
                            className={`queue-card ${isFirst ? 'position-first' : ''} ${item.isResting ? 'resting' : ''} ${isPinned ? 'pinned-driver' : ''}`}
                          >
                            <div className="queue-card-left">
                              <span className="queue-pos">#{index + 1}</span>
                              <span className="queue-hull">{item.hullNumber}</span>
                            </div>
                            <div className="queue-card-middle">
                              <span className="queue-time">{formatJoinTime(item.joinedAt)} WIB</span>
                              <span className="queue-duration">{getDurationText(item.joinedAt)}</span>
                            </div>
                            <div className="queue-card-right">
                              <span className={`status-pill ${item.isResting ? 'resting' : 'active'}`}>
                                {item.isResting ? '☕ Istirahat' : 'Mengantre'}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* SECTION 2: TANDON QUEUE */}
                <div className="detail-section">
                  <div className="section-header tandon-header">
                    <span className="section-title">
                      <span className="parking-icon-box">P</span> Antrean Tandon
                    </span>
                    <span className="section-count">
                      {activePoiQueues?.tandon?.length || 0} / {activePoi.maxTandon}
                    </span>
                  </div>
                  {(!activePoiQueues?.tandon || activePoiQueues.tandon.length === 0) ? (
                    <div className="queue-empty" style={{ padding: '32px 16px' }}>
                      <span className="queue-empty-title">Tidak ada antrean tandon</span>
                      <span className="queue-empty-desc">Tandon parkir kosong untuk saat ini.</span>
                    </div>
                  ) : (
                    <div className="queue-list">
                      {activePoiQueues.tandon.map((item, index) => {
                        const isFirst = index === 0;
                        const isPinned = pinnedHull && item.hullNumber.trim().toLowerCase() === pinnedHull.trim().toLowerCase();
                        return (
                          <div 
                            key={item.id} 
                            className={`queue-card ${isFirst ? 'position-first' : ''} ${item.isResting ? 'resting' : ''} ${isPinned ? 'pinned-driver' : ''}`}
                          >
                            <div className="queue-card-left">
                              <span className="queue-pos">#{index + 1}</span>
                              <span className="queue-hull">{item.hullNumber}</span>
                            </div>
                            <div className="queue-card-middle">
                              <span className="queue-time">{formatJoinTime(item.joinedAt)} WIB</span>
                              <span className="queue-duration">{getDurationText(item.joinedAt)}</span>
                            </div>
                            <div className="queue-card-right">
                              <span className={`status-pill ${item.isResting ? 'resting' : 'active'}`}>
                                {item.isResting ? '☕ Istirahat' : 'Mengantre'}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ONBOARDING MODAL OVERLAY */}
      {showOnboarding && (
        <div className="onboarding-overlay">
          <div className="onboarding-card">
            <div className="onboarding-icon-box">
              <svg className="onboarding-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
            </div>
            <h3 className="onboarding-title">Nomor Lambung Driver</h3>
            <p className="onboarding-desc">
              Masukkan nomor lambung untuk menyorot posisi antrean Anda secara otomatis dan mengaktifkan peringatan suara (beep) ketika antrean Anda naik.
            </p>
            
            <div className="onboarding-input-wrapper">
              <input 
                type="text" 
                className="onboarding-input" 
                placeholder="Contoh: 006 atau GT-10006" 
                value={onboardingInput}
                onChange={(e) => {
                  setOnboardingInput(e.target.value);
                  setOnboardingError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleOnboardingSave();
                }}
                autoFocus
              />
              {onboardingError && <p className="onboarding-error">{onboardingError}</p>}
            </div>

            <div className="onboarding-buttons">
              <button className="onboarding-btn-skip" onClick={handleOnboardingSkip}>
                Lewati
              </button>
              <button className="onboarding-btn-save" onClick={handleOnboardingSave}>
                Simpan
              </button>
            </div>
          </div>
        </div>
      )}

      {/* GUIDE MODAL OVERLAY */}
      {showGuide && (
        <div className="guide-overlay" onClick={() => {
          trackAction('close_help_guide', { method: 'overlay_click' });
          setShowGuide(false);
        }}>
          <div className="guide-card" onClick={(e) => e.stopPropagation()}>
            <div className="guide-header">
              <h3 className="guide-title">ℹ️ Panduan Antrean WhatsApp</h3>
              <button className="guide-close-btn" onClick={() => {
                trackAction('close_help_guide', { method: 'close_button' });
                setShowGuide(false);
              }}>×</button>
            </div>
            <div className="guide-body">
              <p className="guide-subtitle-text">
                Kirim pesan dengan format berikut ke nomor WhatsApp bot koordinator untuk memperbarui antrean Anda:
              </p>
              <ul className="guide-list">
                <li>
                  <span className="guide-cmd"><code>[No_Lambung] in</code></span>
                  <span className="guide-desc">Masuk antrean (contoh: <strong>006 in</strong>)</span>
                </li>
                <li>
                  <span className="guide-cmd"><code>[No_Lambung] out</code></span>
                  <span className="guide-desc">Keluar dari antrean (contoh: <strong>006 out</strong>)</span>
                </li>
                <li>
                  <span className="guide-cmd"><code>[No_Lambung] pos</code></span>
                  <span className="guide-desc">Cek urutan posisi antrean Anda (contoh: <strong>006 pos</strong>)</span>
                </li>
                <li>
                  <span className="guide-cmd"><code>[No_Lambung] off</code></span>
                  <span className="guide-desc">Istirahat / Ngopi (contoh: <strong>006 off</strong> - maksimal 45 menit, jatah 1x)</span>
                </li>
                <li>
                  <span className="guide-cmd"><code>[No_Lambung] on</code></span>
                  <span className="guide-desc">Selesai istirahat / aktif kembali (contoh: <strong>006 on</strong>)</span>
                </li>
              </ul>
              <div className="guide-footer-note">
                *Harap pastikan nomor WhatsApp Anda sudah terdaftar di sistem koordinator.
              </div>
            </div>
            <button className="guide-done-btn" onClick={() => {
              trackAction('close_help_guide', { method: 'understand_button' });
              setShowGuide(false);
            }}>Mengerti</button>
          </div>
        </div>
      )}
    </div>
  );
}
