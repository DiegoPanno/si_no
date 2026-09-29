import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronUp, ChevronDown, RotateCcw, Play, CheckCircle2 } from 'lucide-react';

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  // Estados
  const [faceDetected, setFaceDetected] = useState(false);
  const [currentRatio, setCurrentRatio] = useState(0.40);
  const [neutralPoint, setNeutralPoint] = useState(null); // null = Modo Calibración
  const [activeZone, setActiveZone] = useState(null);     // 'UP' | 'DOWN' | null
  const [progress, setProgress] = useState(0);
  
  // Estado exclusivo para el flujo de calibración inicial
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibProgress, setCalibProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState('Esperando detección de rostro...');

  // Sensibilidad
  const [sensitivity, setSensitivity] = useState(0.035); 
  const dwellTime = 1000; // 1 segundo fijo

  // Referencias para temporizador
  const neutralPointRef = useRef(null);
  const activeZoneRef = useRef(null);
  const dwellStartRef = useRef(null);
  const lastTriggerRef = useRef(0);
  const historyRef = useRef([]);

  // Síntesis de voz en español
  const speak = useCallback((text) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'es-ES';
      utterance.rate = 0.95;
      window.speechSynthesis.speak(utterance);
    }
  }, []);

  // Cálculo binocular de ratio
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
    // Suavizado de 5 lecturas
    historyRef.current.push(rawRatio);
    if (historyRef.current.length > 5) historyRef.current.shift();
    const ratio = historyRef.current.reduce((a, b) => a + b, 0) / historyRef.current.length;
    
    setCurrentRatio(parseFloat(ratio.toFixed(3)));

    // Si aún está en la pantalla de calibración, no procesa SÍ / NO
    const neutral = neutralPointRef.current;
    if (neutral === null) return;

    const now = performance.now();

    // Pausa protectora de 2 segundos post respuesta
    if (now - lastTriggerRef.current < 2000) {
      resetSelection();
      return;
    }

    let detected = null;

    // Regla correcta comprobada:
    if (ratio > neutral + sensitivity) {
      detected = 'UP';   // Mirar arriba -> SÍ
    } else if (ratio < neutral - sensitivity) {
      detected = 'DOWN'; // Mirar abajo -> NO
    } else {
      detected = null;   // Centro / descanso
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

  useEffect(() => {
    const FaceMeshClass = window.FaceMesh;
    const CameraClass = window.Camera;
    if (!FaceMeshClass || !CameraClass) return;

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
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

      if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        setFaceDetected(true);
        setStatusMsg('Rostro detectado');
        const lm = results.multiFaceLandmarks[0];

        // Puntos cian en los iris
        [468, 473].forEach((idx) => {
          const pt = lm[idx];
          ctx.beginPath();
          ctx.arc(pt.x * canvas.width, pt.y * canvas.height, 3, 0, 2 * Math.PI);
          ctx.fillStyle = '#00ffff';
          ctx.fill();
        });

        const ratio = calculateRatio(lm);
        if (ratio !== null) {
          evaluateGaze(ratio);
        } else {
          resetSelection();
        }
      } else {
        setFaceDetected(false);
        setStatusMsg('No se detecta rostro');
        resetSelection();
      }
      ctx.restore();
    });

    let camera = null;
    if (videoRef.current) {
      camera = new CameraClass(videoRef.current, {
        onFrame: async () => {
          if (videoRef.current) {
            await faceMesh.send({ image: videoRef.current });
          }
        },
        width: 640,
        height: 480
      });
      camera.start().catch((err) => console.error(err));
    }

    return () => {
      if (camera) camera.stop();
      faceMesh.close();
    };
  }, [evaluateGaze]);

  // Rutina de calibración en 2 segundos
  const startCalibrationRoutine = () => {
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
        } else {
          alert('No se pudo registrar la mirada. Por favor intente de nuevo.');
        }
      }
    }, 50);
  };

  const isResting = faceDetected && neutralPoint !== null && activeZone === null;

  return (
    <div className="app-container">
      {/* Video Oculto */}
      <video ref={videoRef} playsInline style={{ display: 'none' }} />

      {/* ========================================================
          FASE 1: PANTALLA INICIAL EXCLUSIVA DE CALIBRACIÓN
          ======================================================== */}
      {neutralPoint === null ? (
        <div className="calibration-screen">
          <div className="calib-header">
            <h1 className="calib-title">Ajuste de Mirada</h1>
            <p className="calib-subtitle">
              Pídale al paciente que mire relajado el círculo central
            </p>
          </div>

          {/* Diana Central Gigante */}
          <div className="calib-center-target">
            <div className="target-outer-ring">
              <div className="target-inner-circle">
                <div className="target-center-dot" />
              </div>
            </div>
            <span className="target-text">
              {isCalibrating ? 'Guardando reposo...' : 'Mirar Aquí'}
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

          {/* Panel inferior para el cuidador */}
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
           FASE 2: COMUNICADOR ACTIVO (SÍ / NO A PANTALLA COMPLETA)
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

          {/* Barra divisoria con Diana de Descanso */}
          <div className="dock">
            <div className="dock-left">
              <div className="preview-wrapper">
                <canvas ref={canvasRef} className="preview-canvas" width="160" height="110" />
              </div>

              <div className="status-badge">
                <span className={`status-led ${faceDetected ? 'ready' : ''}`} />
                <div>
                  <small style={{ opacity: 0.85, fontFamily: 'monospace' }}>
                    Ojo: <b>{currentRatio}</b> | Base: <b>{neutralPoint}</b>
                  </small>
                </div>
              </div>
            </div>

            {/* Diana de Descanso en Modo Activo */}
            <div className={`resting-target-container ${isResting ? 'is-resting' : ''}`}>
              <div className="resting-target">
                <div className="resting-inner-dot" />
              </div>
              <span className="resting-label">
                {isResting ? 'Descansando' : 'Centro'}
              </span>
            </div>

            {/* Controles para el acompañante */}
            <div className="dock-right">
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
                onClick={() => {
                  neutralPointRef.current = null;
                  setNeutralPoint(null); // Regresa a la pantalla de calibración limpia
                }}
                title="Volver a calibrar la postura"
              >
                <RotateCcw size={15} />
                Recalibrar
              </button>
            </div>
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
        </>
      )}
    </div>
  );
}