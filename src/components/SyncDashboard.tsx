import React, { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, CheckCircle, XCircle, Clock } from 'lucide-react';
import { showSuccess, showError } from '@/utils/toast';

interface SyncStatus {
  status: 'Idle' | 'Running' | 'Completed' | 'Error';
  timestamp: string;
  processedCount: number;
  totalRecordings: number;
  error: string | null;
}

const initialStatus: SyncStatus = {
  status: 'Idle',
  timestamp: new Date().toISOString(),
  processedCount: 0,
  totalRecordings: 0,
  error: null,
};

const SyncDashboard: React.FC = () => {
  const [status, setStatus] = useState<SyncStatus>(initialStatus);
  const [isManualSyncing, setIsManualSyncing] = useState(false);

  const fetchStatus = async () => {
    try {
      const response = await fetch('/api/status');
      if (response.ok) {
        const data: SyncStatus = await response.json();
        setStatus(data);
      }
    } catch (error) {
      console.error("Failed to fetch sync status:", error);
    }
  };

  useEffect(() => {
    fetchStatus(); // Initial fetch

    // Poll for status updates every 5 seconds
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleStartSync = async () => {
    if (status.status === 'Running' || isManualSyncing) return;

    setIsManualSyncing(true);
    setStatus(prev => ({ ...prev, status: 'Running', error: null }));

    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
      });

      if (response.ok) {
        showSuccess("Sync process initiated on the server.");
      } else {
        const errorData = await response.json();
        showError(`Failed to start sync: ${errorData.error || 'Server error'}`);
        setStatus(prev => ({ ...prev, status: 'Error', error: errorData.error || 'Failed to start sync' }));
      }
    } catch (error) {
      showError("Network error: Could not connect to the backend server.");
      setStatus(prev => ({ ...prev, status: 'Error', error: 'Network error' }));
    } finally {
      setIsManualSyncing(false);
      // Status polling will pick up the final result
    }
  };

  const getStatusIcon = (currentStatus: SyncStatus['status']) => {
    switch (currentStatus) {
      case 'Running':
        return <Loader2 className="w-6 h-6 animate-spin text-blue-500" />;
      case 'Completed':
        return <CheckCircle className="w-6 h-6 text-green-500" />;
      case 'Error':
        return <XCircle className="w-6 h-6 text-red-500" />;
      case 'Idle':
      default:
        return <Clock className="w-6 h-6 text-gray-500" />;
    }
  };

  const getStatusText = (currentStatus: SyncStatus['status']) => {
    switch (currentStatus) {
      case 'Running':
        return 'Syncing in progress...';
      case 'Completed':
        return 'Last sync completed successfully.';
      case 'Error':
        return 'Sync failed. Check server logs.';
      case 'Idle':
      default:
        return 'Waiting for scheduled run or manual trigger.';
    }
  };

  const isSyncDisabled = status.status === 'Running' || isManualSyncing;

  return (
    <Card className="w-full max-w-lg mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          {getStatusIcon(status.status)}
          Zoho Recording Sync
        </CardTitle>
        <CardDescription>
          Automated backup of Zoho Meeting recordings to Google Cloud Storage.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex justify-between items-center border-b pb-2">
          <span className="font-medium">Current Status:</span>
          <span className={`font-semibold ${status.status === 'Error' ? 'text-red-500' : status.status === 'Completed' ? 'text-green-500' : status.status === 'Running' ? 'text-blue-500' : 'text-gray-500'}`}>
            {getStatusText(status.status)}
          </span>
        </div>

        <div className="space-y-2 text-sm">
          <p><strong>Last Run:</strong> {new Date(status.timestamp).toLocaleString()}</p>
          <p><strong>Recordings Found:</strong> {status.totalRecordings}</p>
          <p><strong>New Uploads:</strong> {status.processedCount}</p>
          {status.error && (
            <p className="text-red-500 break-words"><strong>Error Details:</strong> {status.error}</p>
          )}
        </div>

        <Button 
          onClick={handleStartSync} 
          disabled={isSyncDisabled}
          className="w-full"
        >
          {isManualSyncing || status.status === 'Running' ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Starting Sync...
            </>
          ) : (
            'Start Manual Sync Now'
          )}
        </Button>
        <p className="text-xs text-muted-foreground text-center">
          A scheduled sync runs automatically every 30 minutes.
        </p>
      </CardContent>
    </Card>
  );
};

export default SyncDashboard;