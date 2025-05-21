import React from 'react';
import Link from 'next/link';

type Property = {
  id: string;
  title: string;
  location: string;
  price?: number; // Make price optional
  area_sqft: number;
};

const PropertyMapCard: React.FC<Property> = ({ id, title, location, price, area_sqft }) => {
  return (
    <Link href={`/property/${id}`} className="property-map-card" style={styles.propertyCard}>
      <div className="font-bold text-lg">{title}</div>
      <div className="text-sm text-gray-600">{location}</div>
      <div className="text-md text-green-700 font-semibold">
        {price !== undefined ? `₹${price.toLocaleString()}` : 'Price not available'}
      </div>
      <div className="text-sm text-gray-800">{area_sqft} sqft</div>
    </Link>
  );
};

const styles = {
  propertyCard: {
    padding: '8px',
    border: '1px solid #ccc',
    borderRadius: '4px',
    backgroundColor: 'white',
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.1)',
    cursor: 'pointer',
    width: '200px',
  },
};

export default PropertyMapCard;