import { useEffect, useRef } from 'react';
import { useMapsLibrary } from '@vis.gl/react-google-maps';

export default function GoogleMapsAddressInput({ 
  value, 
  onChange 
}: { 
  value: string; 
  onChange: (address: string) => void;
}) {
  const placesLib = useMapsLibrary('places');
  const inputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);

  useEffect(() => {
    if (!placesLib || !inputRef.current) return;
    
    // Initialize Autocomplete
    autocompleteRef.current = new placesLib.Autocomplete(inputRef.current, {
      fields: ['formatted_address', 'name', 'geometry'],
    });
    
    autocompleteRef.current.addListener('place_changed', () => {
      const place = autocompleteRef.current?.getPlace();
      if (place && place.formatted_address) {
        onChange(place.formatted_address);
      } else if (place && place.name) {
        onChange(place.name);
      }
    });
    
  }, [placesLib, onChange]);

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder="Start typing your address or location..."
      className="w-full text-xs border border-stone-355 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-stone-50/50"
    />
  );
}
