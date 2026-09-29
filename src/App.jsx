import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronUp, ChevronDown, RotateCcw, Play, Settings2, X } from 'lucide-react';

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  // Estados
  const [faceDetected, setFaceDetected] = useState(false);
  const [currentRatio, setCurrentRatio] = useState(0.40);
  const [neutralPoint, setNeutralPoint] = useState(null); // null = Pantalla de calibración
  const [activeZone, setActiveZone] = useState(null);     // 'UP' | 'DOWN' | null
  const [progress, setProgress] = useState(0);
  
  // Panel de control para el cuidador (oculto por defecto)
  const [showCaregiverMenu, setShowCaregiverMenu] = useState(false);

  // Calibración inicial
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibProgress, setCalibProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState('Esperando cámara y rostro...');

  // Sensibilidad
  const [sensitivity, setSensitivity] = useState(0.035); 
  const dwellTime = 1000; // 1 segundo sostenido para confirmar

  // Referencias internas
  const neutralPointRef = useRef(null);
  const activeZoneRef = useRef(null);
  const dwellStartRef = useRef(null);
  const lastTriggerRef = useRef(0);
  const historyRef = useRef([]);
  const isRunningRef = useRef(false);

  // Síntesis de voz accesible
  const speak = useCallback((text) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'es-ES';
      utterance.rate = 0.95;
      window.speechSynthesis.speak(utterance);
    }
  }, []);

  // Cálculo binocular del ratio de los ojos
  const calculateRatio = (landmarks) => {
    const topL = landmarks[159].y;
    const botL = landmarks[145].y;
    const irisL = landmarks[468].y;
    const hL = botL - topL;

    const topR = landmarks[386].y;
    const botR = landmarks[374].y;
    const irisR = landmarks[473].y;
    const hR = botR - topR;

    if (hL < 0.007 || hR < 0.007) return null; // Ojos cerrados

    const rL = (irisL - topL) / hL;
    const rR = (irisR - topR) / hR;
    return (rL + rR) / 2;
  };

  const evaluateGaze = useCallback((rawRatio) => {
    historyRef.current.push(rawRatio);
    if (historyRef.current.length > 5) historyRef.current.shift();
    const ratio = historyRef.current.reduce((a, b) => a + b, 0) / historyRef.current.length;
    
    setCurrentRatio(parseFloat(ratio.toFixed(3)));

    const neutral = neutralPointRef.current;
    if (neutral === null) return;

    const now = performance.now();

    // Pausa protectora de 2 segundos tras hablar
    if (now - lastTriggerRef.current < 2000) {
      resetSelection();
      return;
    }

    let detected = null;

    if (ratio > neutral + sensitivity) {
      detected = 'UP';   // Arriba -> SÍ
    } else if (ratio < neutral - sensitivity) {
      detected = 'DOWN'; // Abajo -> NO
    } else {
      detected = null;   // Centro neutro de descanso
    }

    if (detected && detected === activeZoneRef.current) {
      const elapsed = now - dwellStartRef.current;
      const pct = Math.min((elapsed / dwellTime) * 100, 100);
      setProgress(pct);

      if (elapsed >= dwellTime) {
        if (detected === 'UP') speak('Sí');
        if (detected === 'DOWN') speak('No');

        lastTriggerRef.current = now;
        resetSelection();
      }
    } else if (detected) {
      activeZoneRef.current = detected;
      dwellStartRef.current = now;
      setActiveZone(detected);
    } else {
      resetSelection();
    }
  }, [sensitivity, dwellTime, speak]);

  const resetSelection = () => {
    activeZoneRef.current = null;
    dwellStartRef.current = null;
    setActiveZone(null);
    setProgress(0);
  };

  // Inicialización de cámara compatible con iOS Safari y MediaPipe
  useEffect(() => {
    const FaceMeshClass = window.FaceMesh;
    if (!FaceMeshClass) return;

    const faceMesh = new FaceMeshClass({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });

    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });

    faceMesh.onResults((results) => {
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

        if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
          const lm = results.multiFaceLandmarks[0];
          [468, 473].forEach((idx) => {
            const pt = lm[idx];
            ctx.beginPath();
            ctx.arc(pt.x * canvas.width, pt.y * canvas.height, 3, 0, 2 * Math.PI);
            ctx.fillStyle = '#00ffff';
            ctx.fill();
          });
        }
        ctx.restore();
      }

      if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        setFaceDetected(true);
        setStatusMsg('Rostro detectado');
        const ratio = calculateRatio(results.multiFaceLandmarks[0]);
        if (ratio !== null) {
          evaluateGaze(ratio);
        } else {
          resetSelection();
        }
      } else {
        setFaceDetected(false);
        setStatusMsg('Buscando rostro...');
        resetSelection();
      }
    });

    let stream = null;
    let animFrameId = null;

    const startCamera = async () => {
      try {
        const constraints = {
          audio: false,
          video: {
            facingMode: 'user',
            width: { ideal: 640 },
            height: { ideal: 480 }
          }
        };

        stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();

          isRunningRef.current = true;

          const processFrame = async () => {
            if (isRunningRef.current && videoRef.current && videoRef.current.readyState >= 2) {
              await faceMesh.send({ image: videoRef.current });
            }
            if (isRunningRef.current) {
              animFrameId = requestAnimationFrame(processFrame);
            }
          };
          processFrame();
        }
      } catch (err) {
        console.error('Error con la cámara:', err);
        setStatusMsg('Permite acceso a la cámara');
      }
    };

    startCamera();

    return () => {
      isRunningRef.current = false;
      if (animFrameId) cancelAnimationFrame(animFrameId);
      if (stream) stream.getTracks().forEach((track) => track.stop());
      faceMesh.close();
    };
  }, [evaluateGaze]);

  const startCalibrationRoutine = () => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    }

    setIsCalibrating(true);
    setCalibProgress(0);
    const samples = [];
    const startTime = performance.now();
    const duration = 2000;

    const interval = setInterval(() => {
      const elapsed = performance.now() - startTime;
      const pct = Math.min((elapsed / duration) * 100, 100);
      setCalibProgress(pct);

      if (currentRatio) samples.push(currentRatio);

      if (elapsed >= duration) {
        clearInterval(interval);
        setIsCalibrating(false);

        if (samples.length > 8) {
          const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
          const finalVal = parseFloat(avg.toFixed(3));
          neutralPointRef.current = finalVal;
          setNeutralPoint(finalVal);
          setShowCaregiverMenu(false); // Cierra cualquier menú técnico
        } else {
          alert('No se detectaron los ojos con claridad. Intenta de nuevo.');
        }
      }
    }, 50);
  };

  return (
    <div className="app-container">
      <video 
        ref={videoRef} 
        playsInline 
        webkit-playsinline="true"
        autoPlay 
        muted 
        style={{ display: 'none' }} 
      />

      {/* ========================================================
          FASE 1: PANTALLA DE CALIBRACIÓN INICIAL
          ======================================================== */}
      {neutralPoint === null ? (
        <div className="calibration-screen">
          <div className="calib-header">
            <h1 className="calib-title">Ajuste de Mirada</h1>
            <p className="calib-subtitle">
              Pídale al paciente que mire relajado el círculo central
            </p>
          </div>

          <div className="calib-center-target">
            <div className="target-outer-ring">
              <div className="target-inner-circle">
                <div className="target-center-dot" />
              </div>
            </div>
            <span className="target-text">
              {isCalibrating ? 'Guardando postura...' : 'Mirar Aquí'}
            </span>

            {isCalibrating && (
              <div className="calib-progress-track">
                <div 
                  className="calib-progress-bar" 
                  style={{ width: `${calibProgress}%` }} 
                />
              </div>
            )}
          </div>

          {/* El video y datos solo se muestran aquí para que el cuidador verifique */}
          <div className="calib-footer">
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div className="preview-wrapper">
                <canvas ref={canvasRef} className="preview-canvas" width="160" height="110" />
              </div>
              <div className="status-badge">
                <span className={`status-led ${faceDetected ? 'ready' : ''}`} />
                <span style={{ fontSize: '0.9rem' }}>{statusMsg}</span>
              </div>
            </div>

            <button 
              className="btn-start-calib" 
              onClick={startCalibrationRoutine}
              disabled={isCalibrating || !faceDetected}
            >
              {isCalibrating ? (
                <>
                  <RotateCcw size={20} className="spin" />
                  Calibrando...
                </>
              ) : (
                <>
                  <Play size={20} fill="white" />
                  Comenzar Calibración
                </>
              )}
            </button>
          </div>
        </div>
      ) : (
        /* ========================================================
           FASE 2: MODO COMUNICACIÓN PURA (100% LIMPIO PARA EL PACIENTE)
           ======================================================== */
        <>
          {/* Zona Superior: SÍ */}
          <div 
            className={`zone zone-yes ${activeZone === 'UP' ? 'active' : ''}`}
            onClick={() => speak('Sí')}
          >
            <div className="zone-content">
              <ChevronUp className="zone-icon" strokeWidth={3.5} />
              <span className="zone-title">SÍ</span>
              <span className="zone-sub">Mirar Arriba</span>
            </div>
            <div className="progress-bar-bg">
              <div 
                className="progress-fill" 
                style={{ width: activeZone === 'UP' ? `${progress}%` : '0%' }}
              />
            </div>
          </div>

          {/* FRANJA CENTRAL MINIMALISTA (ZONA DE DESCANSO VACÍA) */}
          <div 
            className="dock" 
            style={{ 
              height: '48px', 
              padding: '0 16px',
              backgroundColor: '#0d1117',
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)'
            }}
          >
            {/* Pequeño punto LED de estado en la esquina (apenas visible) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span 
                className={`status-led ${faceDetected ? 'ready' : ''}`} 
                style={{ width: '8px', height: '8px' }}
                title={faceDetected ? 'Rostro conectado' : 'Sin rostro'}
              />
            </div>

            {/* CENTRO VACÍO: Descanso visual absoluto */}
            <div style={{ flex: 1 }} />

            {/* Botón discreto de Ajustes para el Cuidador */}
            <button 
              className="btn-action" 
              style={{ padding: '6px 12px', fontSize: '0.8rem', background: 'transparent', border: 'none', opacity: 0.6 }}
              onClick={() => setShowCaregiverMenu(!showCaregiverMenu)}
              title="Ajustes de cuidador"
            >
              <Settings2 size={18} />
            </button>
          </div>

          {/* Zona Inferior: NO */}
          <div 
            className={`zone zone-no ${activeZone === 'DOWN' ? 'active' : ''}`}
            onClick={() => speak('No')}
          >
            <div className="progress-bar-bg">
              <div 
                className="progress-fill" 
                style={{ width: activeZone === 'DOWN' ? `${progress}%` : '0%' }}
              />
            </div>
            <div className="zone-content">
              <span className="zone-title">NO</span>
              <span className="zone-sub">Mirar Abajo</span>
              <ChevronDown className="zone-icon" strokeWidth={3.5} />
            </div>
          </div>

          {/* MENÚ FLOTANTE OPCIONAL DEL CUIDADOR (solo aparece al tocar la ruedita) */}
          {showCaregiverMenu && (
            <div style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              background: '#161b22',
              border: '1px solid #30363d',
              padding: '20px',
              borderRadius: '12px',
              zIndex: 100,
              boxShadow: '0 8px 30px rgba(0,0,0,0.8)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              minWidth: '280px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700 }}>Ajustes de Asistencia</span>
                <button 
                  onClick={() => setShowCaregiverMenu(false)}
                  style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer' }}
                >
                  <X size={18} />
                </button>
              </div>

              <div style={{ fontSize: '0.85rem', color: '#8b949e' }}>
                Posición: <b>{currentRatio}</b> | Base: <b>{neutralPoint}</b>
              </div>

              <div className="control-slider">
                <span>Esfuerzo: {sensitivity === 0.025 ? 'Leve' : sensitivity === 0.035 ? 'Medio' : 'Alto'}</span>
                <input 
                  type="range" 
                  min="0.020" 
                  max="0.055" 
                  step="0.005"
                  value={sensitivity} 
                  onChange={(e) => setSensitivity(parseFloat(e.target.value))} 
                />
              </div>

              <button 
                className="btn-action" 
                style={{ width: '100%', justifyContent: 'center', background: '#238636', color: '#fff', border: 'none', padding: '10px' }}
                onClick={() => {
                  neutralPointRef.current = null;
                  setNeutralPoint(null); // Regresa a calibración inicial
                }}
              >
                <RotateCcw size={16} />
                Volver a Calibrar Mirada
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}