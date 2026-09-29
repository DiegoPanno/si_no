import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronUp, ChevronDown, Check, RotateCcw, Eye } from 'lucide-react';

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  // Estados del sistema
  const [faceDetected, setFaceDetected] = useState(false);
  const [currentRatio, setCurrentRatio] = useState(0.40);
  const [neutralPoint, setNeutralPoint] = useState(null); // Punto neutro del paciente
  const [activeZone, setActiveZone] = useState(null);     // 'UP' | 'DOWN' | null
  const [progress, setProgress] = useState(0);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [statusMsg, setStatusMsg] = useState('Esperando rostro...');

  // Sensibilidad mínima accesible (apenas 0.035 de desvío para no fatigar)
  const [sensitivity, setSensitivity] = useState(0.035); 
  const [dwellTime, setDwellTime] = useState(1000); // 1 segundo fijo

  // Referencias para el bucle de tiempo
  const neutralPointRef = useRef(null);
  const activeZoneRef = useRef(null);
  const dwellStartRef = useRef(null);
  const lastTriggerRef = useRef(0);
  const historyRef = useRef([]);

  // Síntesis de voz clara y pausada
  const speak = useCallback((text) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'es-ES';
      utterance.rate = 0.9;
      window.speechSynthesis.speak(utterance);
    }
  }, []);

  // Cálculo binocular: promedio de ambos ojos
  const calculateRatio = (landmarks) => {
    // Ojo Izquierdo
    const topL = landmarks[159].y;
    const botL = landmarks[145].y;
    const irisL = landmarks[468].y;
    const hL = botL - topL;

    // Ojo Derecho
    const topR = landmarks[386].y;
    const botR = landmarks[374].y;
    const irisR = landmarks[473].y;
    const hR = botR - topR;

    // Si pestañea o cierra los ojos por descanso
    if (hL < 0.007 || hR < 0.007) return null;

    const rL = (irisL - topL) / hL;
    const rR = (irisR - topR) / hR;
    return (rL + rR) / 2;
  };

  const evaluateGaze = useCallback((rawRatio) => {
    // Suavizado de 5 lecturas para eliminar temblores involuntarios
    historyRef.current.push(rawRatio);
    if (historyRef.current.length > 5) historyRef.current.shift();
    const ratio = historyRef.current.reduce((a, b) => a + b, 0) / historyRef.current.length;
    
    setCurrentRatio(parseFloat(ratio.toFixed(3)));

    // Si todavía el cuidador no calibró el reposo, no se activa nada
    const neutral = neutralPointRef.current;
    if (neutral === null) return;

    const now = performance.now();

    // Pausa protectora de 2 segundos tras emitir una respuesta para no cansar
    if (now - lastTriggerRef.current < 2000) {
      resetSelection();
      return;
    }

    let detected = null;

    // Arriba (SÍ): el iris sube (el valor disminuye respecto al centro)
    if (ratio < neutral - sensitivity) {
      detected = 'DOWN';
    } 
    // Abajo (NO): el iris baja (el valor sube respecto al centro)
    else if (ratio > neutral + sensitivity) {
      detected = 'UP';
    } 
    // Zona de descanso neutra: no hace nada
    else {
      detected = null;
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

  // Inicialización de MediaPipe
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
        const lm = results.multiFaceLandmarks[0];

        // Puntos cian en los iris para que el cuidador vea si la cámara enfoca bien
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

  // Calibración pasiva: toma el promedio de reposo en 2 segundos
  const handleCalibrate = () => {
    setIsCalibrating(true);
    setStatusMsg('Registrando posición de reposo...');
    const samples = [];

    const interval = setInterval(() => {
      if (currentRatio) samples.push(currentRatio);
    }, 80);

    setTimeout(() => {
      clearInterval(interval);
      if (samples.length > 8) {
        const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
        const finalVal = parseFloat(avg.toFixed(3));
        neutralPointRef.current = finalVal;
        setNeutralPoint(finalVal);
        setStatusMsg('✓ Calibrado con éxito');
      } else {
        setStatusMsg('Error: mantenga la cara frente a la cámara');
      }
      setIsCalibrating(false);
    }, 1800);
  };

  // Cálculo visual de la desviación actual frente al centro
  const delta = neutralPoint !== null ? currentRatio - neutralPoint : 0;
  // delta negativo = mirando arriba; delta positivo = mirando abajo

  return (
    <div className="app-container">
      <video ref={videoRef} playsInline style={{ display: 'none' }} />

      {/* Zona Superior: SÍ */}
      <div 
        className={`zone zone-yes ${activeZone === 'UP' ? 'active' : ''}`}
        onClick={() => speak('Sí')}
      >
        <div className="zone-content">
          <ChevronUp size={84} strokeWidth={3.5} />
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

      {/* Panel Central Asistivo */}
      <div className="dock" style={{ height: '125px', padding: '0 20px' }}>
        <div className="dock-left" style={{ gap: '15px' }}>
          <div className="preview-wrapper">
            <canvas ref={canvasRef} className="preview-canvas" width="160" height="110" />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className={`status-led ${faceDetected && neutralPoint !== null ? 'ready' : ''}`} />
              <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>{statusMsg}</span>
            </div>

            {/* Medidor visual de desviación para el cuidador */}
            {neutralPoint !== null ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', background: '#21262d', padding: '4px 10px', borderRadius: '6px' }}>
                <span>Arriba</span>
                <div style={{ width: '90px', height: '8px', background: '#30363d', borderRadius: '4px', position: 'relative' }}>
                  {/* Punto central */}
                  <div style={{ position: 'absolute', left: '50%', top: '-2px', width: '2px', height: '12px', background: '#8b949e' }} />
                  {/* Indicador de posición en tiempo real */}
                  <div style={{
                    position: 'absolute',
                    top: '-3px',
                    left: `${Math.min(Math.max(50 + (delta / 0.1) * 50, 0), 100)}%`,
                    width: '14px',
                    height: '14px',
                    borderRadius: '50%',
                    background: Math.abs(delta) > sensitivity ? '#10b981' : '#58a6ff',
                    transform: 'translateX(-50%)',
                    transition: 'left 0.05s linear'
                  }} />
                </div>
                <span>Abajo</span>
              </div>
            ) : (
              <small style={{ color: '#f59e0b' }}>⚠️ Presione "Guardar Reposo" para empezar</small>
            )}
          </div>
        </div>

        {/* Controles para el acompañante / cuidador */}
        <div className="dock-right" style={{ gap: '20px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.8rem' }}>
            <span>Esfuerzo necesario: {sensitivity === 0.025 ? 'Muy leve' : sensitivity === 0.035 ? 'Normal' : 'Pronunciado'}</span>
            <input 
              type="range" 
              min="0.020" 
              max="0.060" 
              step="0.005"
              value={sensitivity} 
              onChange={(e) => setSensitivity(parseFloat(e.target.value))} 
            />
          </div>

          <button 
            className="btn-action" 
            style={{ padding: '12px 20px', fontSize: '1rem', background: neutralPoint ? '#238636' : '#2563eb' }}
            onClick={handleCalibrate}
            disabled={isCalibrating || !faceDetected}
          >
            <RotateCcw size={18} className={isCalibrating ? 'spin' : ''} />
            {isCalibrating ? 'Guardando reposo...' : 'Guardar Reposo del Paciente'}
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
          <ChevronDown size={84} strokeWidth={3.5} />
        </div>
      </div>
    </div>
  );
}